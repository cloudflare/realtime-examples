import {
  CHANNEL_PROFILES,
  getProfileTeachingConfig,
  type ChannelProfileId,
} from "./channel-config.ts";
import {
  ExampleApi,
  ExampleError,
  TeardownManager,
  buildBrowserDataChannelOptions,
  createBrowserChannelWithTrackedId,
  sendJsonMessage,
  teardownAfterSetup,
  waitForDataChannelOpen,
  waitForPeerConnectionConnected,
  waitForSetupOperations,
} from "./client.ts";

type Phase =
  | "idle"
  | "connecting"
  | "connected"
  | "closing"
  | "closed"
  | "error";
type EndpointRole = "publisher" | "subscriber";
type StatusTone = "neutral" | "working" | "success" | "error";
type MessageRecord = Record<string, unknown>;

interface Endpoint {
  role: EndpointRole;
  peerConnection: RTCPeerConnection;
  sessionId: string | null;
  channelIds: Set<number>;
  channels: Map<string, RTCDataChannel>;
}

interface Resources {
  publisher: Endpoint | null;
  subscriber: Endpoint | null;
  dataChannels: Set<RTCDataChannel>;
  peerConnections: Set<RTCPeerConnection>;
}

interface Elements {
  connectButton: HTMLButtonElement;
  teardownButton: HTMLButtonElement;
  status: HTMLParagraphElement;
  publisherConnection: HTMLElement;
  subscriberConnection: HTMLElement;
  reliableForm: HTMLFormElement;
  reliableInput: HTMLInputElement;
  reliableButton: HTMLButtonElement;
  probeButton: HTMLButtonElement;
  probeStatus: HTMLParagraphElement;
  ackButton: HTMLButtonElement;
  ackDeadline: HTMLParagraphElement;
  gateState: HTMLElement;
  replyForm: HTMLFormElement;
  replyInput: HTMLInputElement;
  replyButton: HTMLButtonElement;
  stateButton: HTMLButtonElement;
  publisherLog: HTMLOListElement;
  subscriberLog: HTMLOListElement;
  stateLog: HTMLOListElement;
  latestRevision: HTMLElement;
  latestPosition: HTMLElement;
}

const api = new ExampleApi();
const elements = getElements();

let phase: Phase = "idle";
let resources: Resources | null = null;
let teardownManager: TeardownManager | null = null;
let inFlightSetup: Promise<void> | null = null;
let teardownRequested = false;
let acknowledgmentSent = false;
let acknowledgmentExpired = false;
let probeSent = false;
let postAckMessageDelivered = false;
let acknowledgmentDeadline = 0;
let acknowledgmentTimer: ReturnType<typeof setTimeout> | null = null;
let reliableSequence = 0;
let stateRevision = 0;
let latestAppliedStateRevision = 0;

renderTeachingConfiguration();
setGateState("closed");
updateControls();
showStatus(
  "Ready. The Realtime SFU credential stays in the local Node server.",
  "neutral",
);

elements.connectButton.addEventListener(
  "click",
  () => void connectExample(),
);
elements.teardownButton.addEventListener(
  "click",
  () => void teardownExample(),
);
elements.probeButton.addEventListener("click", sendDisposableProbe);
elements.reliableForm.addEventListener("submit", sendReliableMessage);
elements.ackButton.addEventListener("click", sendAcknowledgment);
elements.replyForm.addEventListener("submit", sendSubscriberReply);
elements.stateButton.addEventListener("click", sendStateBurst);
window.addEventListener("pagehide", () => {
  void teardownExample(false);
});

async function connectExample(): Promise<void> {
  if (phase === "connecting" || phase === "connected" || phase === "closing") {
    return;
  }
  if (teardownManager && !teardownManager.isFullyClosed()) {
    showStatus(
      "Finish teardown before creating another pair of Realtime SFU sessions.",
      "error",
    );
    return;
  }

  phase = "connecting";
  teardownRequested = false;
  acknowledgmentSent = false;
  acknowledgmentExpired = false;
  probeSent = false;
  postAckMessageDelivered = false;
  clearAcknowledgmentTimer();
  reliableSequence = 0;
  stateRevision = 0;
  latestAppliedStateRevision = 0;
  clearLogs();
  setGateState("closed");
  elements.probeStatus.textContent =
    "Connecting. Never put required data in this probe.";
  elements.probeStatus.dataset.state = "";
  elements.ackDeadline.textContent =
    "The ACK must arrive within 30 seconds of remote channel creation.";
  const currentResources = createResources();
  resources = currentResources;
  const currentTeardownManager = createTeardownManager(currentResources);
  teardownManager = currentTeardownManager;
  updateControls();
  showStatus("Creating two server-side Realtime SFU sessions...", "working");

  const setupOperation = setupExample(currentResources);
  inFlightSetup = setupOperation;
  try {
    await setupOperation;
    if (teardownRequested) {
      return;
    }

    phase = "connected";
    elements.probeStatus.textContent =
      "Ready. Send one disposable packet while the gate is closed.";
    updateControls();
    showStatus(
      "Connected. Send the disposable probe, confirm the gate stays closed, then send the subscriber ACK.",
      "success",
    );
  } catch (error) {
    clearAcknowledgmentTimer();
    await currentTeardownManager.teardown().catch(() => {});
    if (teardownRequested) {
      return;
    }
    phase = "error";
    updateControls();
    showError("Connection setup failed", error);
  } finally {
    if (inFlightSetup === setupOperation) {
      inFlightSetup = null;
    }
  }
}

async function setupExample(currentResources: Resources): Promise<void> {
  const publisher = createEndpoint("publisher", currentResources);
  const subscriber = createEndpoint("subscriber", currentResources);
  currentResources.publisher = publisher;
  currentResources.subscriber = subscriber;

  await waitForSetupOperations([
    setupEndpoint(publisher),
    setupEndpoint(subscriber),
  ]);

  await createChannelPair("unreliable-unordered", currentResources);
  await createChannelPair("reliable-ordered", currentResources);
  if (acknowledgmentExpired) {
    throw new ExampleError(
      "ack_expired",
      "The 30-second waitForAck window expired during setup. Reconnect to create a fresh remote DataChannel.",
    );
  }
}

function createEndpoint(
  role: EndpointRole,
  currentResources: Resources,
): Endpoint {
  const peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    bundlePolicy: "max-bundle",
  });
  const endpoint: Endpoint = {
    role,
    peerConnection,
    sessionId: null,
    channelIds: new Set<number>(),
    channels: new Map<string, RTCDataChannel>(),
  };
  currentResources.peerConnections.add(peerConnection);

  peerConnection.addEventListener("connectionstatechange", () => {
    setConnectionBadge(role, peerConnection.connectionState);
  });
  peerConnection.addEventListener("datachannel", (event) => {
    registerDataChannel(
      endpoint,
      `transport-${event.channel.id}`,
      event.channel,
      currentResources,
    );
  });
  setConnectionBadge(role, peerConnection.connectionState);
  return endpoint;
}

async function setupEndpoint(endpoint: Endpoint): Promise<void> {
  const session = await api.createSession();
  endpoint.sessionId = session.sessionId;

  const transport = await api.establishTransport(endpoint.sessionId);
  await endpoint.peerConnection.setRemoteDescription(
    transport.sessionDescription,
  );
  const answer = await endpoint.peerConnection.createAnswer();
  await endpoint.peerConnection.setLocalDescription(answer);
  if (answer.type !== "answer" || !answer.sdp) {
    throw new ExampleError(
      "invalid_local_answer",
      "The browser did not create a complete WebRTC answer.",
    );
  }
  await api.renegotiate(endpoint.sessionId, {
    type: answer.type,
    sdp: answer.sdp,
  });
  await waitForPeerConnectionConnected(endpoint.peerConnection, {
    timeoutMs: 20_000,
    label: `${capitalize(endpoint.role)} PeerConnection`,
  });
}

async function createChannelPair(
  profileId: ChannelProfileId,
  currentResources: Resources,
): Promise<void> {
  const profile = CHANNEL_PROFILES[profileId];
  const publisher = requireEndpoint(
    currentResources.publisher,
    "publisher",
  );
  const subscriber = requireEndpoint(
    currentResources.subscriber,
    "subscriber",
  );
  const publisherSessionId = requireEndpointSessionId(publisher);
  const subscriberSessionId = requireEndpointSessionId(subscriber);

  const publisherResult = await api.createDataChannel({
    sessionId: publisherSessionId,
    profile: profileId,
    location: "local",
  });
  const publisherChannel = createBrowserChannelWithTrackedId(
    publisher.channelIds,
    publisherResult.dataChannel.id,
    () =>
      publisher.peerConnection.createDataChannel(
        profile.dataChannelName,
        buildBrowserDataChannelOptions(
          profileId,
          publisherResult.dataChannel.id,
        ),
      ),
  );
  registerDataChannel(
    publisher,
    profileId,
    publisherChannel,
    currentResources,
  );

  const remoteRequestStartedAt = Date.now();
  const subscriberResult = await api.createDataChannel({
    sessionId: subscriberSessionId,
    profile: profileId,
    location: "remote",
    publisherSessionId,
  });
  const subscriberChannel = createBrowserChannelWithTrackedId(
    subscriber.channelIds,
    subscriberResult.dataChannel.id,
    () => {
      if (profileId === "reliable-ordered") {
        startAcknowledgmentDeadline(remoteRequestStartedAt);
      }
      return subscriber.peerConnection.createDataChannel(
        `${profile.dataChannelName}-subscriber`,
        buildBrowserDataChannelOptions(
          profileId,
          subscriberResult.dataChannel.id,
        ),
      );
    },
  );
  registerDataChannel(
    subscriber,
    profileId,
    subscriberChannel,
    currentResources,
  );

  if (profileId === "reliable-ordered") {
    publisherChannel.addEventListener("message", handlePublisherReply);
    subscriberChannel.addEventListener(
      "message",
      handleSubscriberReliableMessage,
    );
  } else {
    subscriberChannel.addEventListener("message", handleStateMessage);
  }

  await waitForSetupOperations([
    waitForDataChannelOpen(publisherChannel, {
      label: `${profile.label} publisher DataChannel`,
    }),
    waitForDataChannelOpen(subscriberChannel, {
      label: `${profile.label} subscriber DataChannel`,
    }),
  ]);
}

function registerDataChannel(
  endpoint: Endpoint,
  key: string,
  dataChannel: RTCDataChannel,
  currentResources: Resources,
): void {
  endpoint.channels.set(key, dataChannel);
  currentResources.dataChannels.add(dataChannel);
  dataChannel.addEventListener("open", () => {
    setChannelBadge(key, "open");
  });
  dataChannel.addEventListener("close", () => {
    setChannelBadge(key, "closed");
  });
  if (!key.startsWith("transport-")) {
    setChannelBadge(key, dataChannel.readyState);
  }
}

function sendDisposableProbe(): void {
  if (probeSent) {
    return;
  }
  try {
    if (acknowledgmentSent) {
      throw new ExampleError(
        "probe_too_late",
        "The gate is already open. Reconnect to test a pre-ACK probe.",
      );
    }
    const publisher = requireEndpoint(
      requireResources().publisher,
      "publisher",
    );
    const channel = publisher.channels.get("reliable-ordered");
    sendJsonMessage(
      channel,
      {
        type: "disposable-probe",
        message: "disposable pre-ACK probe",
      },
      "Reliable ordered publisher DataChannel",
    );
    probeSent = true;
    elements.probeStatus.textContent =
      "Sent while the gate is closed. It must remain absent from the subscriber until ACK.";
    elements.probeStatus.dataset.state = "success";
    appendLog(
      elements.publisherLog,
      "probe",
      "disposable pre-ACK probe",
      "gate closed; delivery and replay are not guaranteed",
    );
    showStatus(
      "Disposable probe sent. It is not delivered while the gate is closed; send the subscriber ACK next.",
      "success",
    );
    updateControls();
  } catch (error) {
    showError("Disposable probe failed", error);
  }
}

function sendReliableMessage(event: SubmitEvent): void {
  event.preventDefault();
  try {
    if (!acknowledgmentSent) {
      throw new ExampleError(
        "ack_required",
        "Send the subscriber ACK before normal publisher traffic.",
      );
    }
    const message = requireMessage(elements.reliableInput.value);
    const publisher = requireEndpoint(
      requireResources().publisher,
      "publisher",
    );
    const channel = publisher.channels.get("reliable-ordered");
    reliableSequence += 1;
    sendJsonMessage(
      channel,
      {
        type: "publisher-message",
        sequence: reliableSequence,
        message,
      },
      "Reliable ordered publisher DataChannel",
    );
    appendLog(
      elements.publisherLog,
      "sent",
      `#${reliableSequence} ${message}`,
      "fresh reliable traffic sent after ACK",
    );
    elements.reliableInput.value = "";
    showStatus(
      "Fresh post-ACK message sent. Waiting for the subscriber to receive it.",
      "working",
    );
  } catch (error) {
    showError("Reliable send failed", error);
  }
}

function sendAcknowledgment(): void {
  if (acknowledgmentSent) {
    return;
  }
  try {
    if (acknowledgmentExpired || Date.now() >= acknowledgmentDeadline) {
      expireAcknowledgment();
      throw new ExampleError(
        "ack_expired",
        "The 30-second waitForAck window expired. Teardown and reconnect to create a new remote DataChannel.",
      );
    }
    if (!probeSent) {
      throw new ExampleError(
        "probe_required",
        "Send the disposable pre-ACK probe before opening the gate.",
      );
    }
    const subscriber = requireEndpoint(
      requireResources().subscriber,
      "subscriber",
    );
    const channel = subscriber.channels.get("reliable-ordered");
    if (channel?.readyState !== "open") {
      throw new ExampleError(
        "datachannel_not_open",
        "The reliable subscriber DataChannel is not open.",
      );
    }
    channel.send("subscriber-ready");
    acknowledgmentSent = true;
    clearAcknowledgmentTimer();
    elements.ackDeadline.textContent =
      "ACK sent. The SFU consumed this first subscriber message.";
    setGateState("open");
    appendLog(
      elements.subscriberLog,
      "ack",
      "subscriber-ready",
      "first message consumed by the SFU",
    );
    showStatus(
      "Gate open. Send a fresh publisher message now; do not use the early probe as delivery proof.",
      "success",
    );
    updateControls();
  } catch (error) {
    showError("Readiness acknowledgment failed", error);
  }
}

function sendSubscriberReply(event: SubmitEvent): void {
  event.preventDefault();
  try {
    if (!acknowledgmentSent) {
      throw new ExampleError(
        "ack_required",
        "Send the readiness acknowledgment first. The SFU consumes that first subscriber message.",
      );
    }
    if (!postAckMessageDelivered) {
      throw new ExampleError(
        "post_ack_message_required",
        "Wait for the subscriber to receive a fresh post-ACK publisher message before replying.",
      );
    }
    const message = requireMessage(elements.replyInput.value);
    const subscriber = requireEndpoint(
      requireResources().subscriber,
      "subscriber",
    );
    const channel = subscriber.channels.get("reliable-ordered");
    sendJsonMessage(
      channel,
      {
        type: "subscriber-reply",
        message,
      },
      "Reliable ordered subscriber DataChannel",
    );
    appendLog(
      elements.subscriberLog,
      "sent",
      message,
      "canReply routes this only to the publisher",
    );
    elements.replyInput.value = "";
  } catch (error) {
    showError("Subscriber reply failed", error);
  }
}

function sendStateBurst(): void {
  try {
    const publisher = requireEndpoint(
      requireResources().publisher,
      "publisher",
    );
    const channel = publisher.channels.get("unreliable-unordered");
    const firstRevision = stateRevision + 1;
    for (let index = 0; index < 8; index += 1) {
      stateRevision += 1;
      sendJsonMessage(
        channel,
        {
          type: "replaceable-state",
          revision: stateRevision,
          x: (stateRevision * 17) % 101,
        },
        "Unreliable unordered publisher DataChannel",
      );
    }
    appendLog(
      elements.stateLog,
      "sent",
      `state revisions ${firstRevision}-${stateRevision}`,
      "ordered: false, maxRetransmits: 0",
    );
  } catch (error) {
    showError("State burst failed", error);
  }
}

function handleSubscriberReliableMessage(
  event: MessageEvent<unknown>,
): void {
  const message = parseMessage(event.data);
  if (message.type === "disposable-probe") {
    const probeMessage =
      typeof message.message === "string"
        ? message.message
        : String(event.data);
    if (!acknowledgmentSent) {
      appendLog(
        elements.subscriberLog,
        "unexpected",
        probeMessage,
        "probe arrived while the waitForAck gate was closed",
      );
      showStatus(
        "Unexpected delivery: the disposable probe arrived before ACK.",
        "error",
      );
      return;
    }
    appendLog(
      elements.subscriberLog,
      "observed",
      probeMessage,
      "bounded early retention observed; do not rely on replay",
    );
    elements.probeStatus.textContent =
      "Observed after ACK. This is bounded early retention, not a replay guarantee; do not rely on it.";
    elements.probeStatus.dataset.state = "observed";
    return;
  }
  appendLog(
    elements.subscriberLog,
    "received",
    typeof message.message === "string"
      ? message.message
      : String(event.data),
    message.sequence
      ? `publisher sequence #${String(message.sequence)}`
      : "",
  );
  if (message.type === "publisher-message") {
    postAckMessageDelivered = true;
    showStatus(
      "Fresh post-ACK message delivered. The subscriber can now reply through canReply.",
      "success",
    );
    updateControls();
  }
}

function handlePublisherReply(event: MessageEvent<unknown>): void {
  const message = parseMessage(event.data);
  appendLog(
    elements.publisherLog,
    "received",
    typeof message.message === "string"
      ? message.message
      : String(event.data),
    "subscriber reply via canReply",
  );
  if (message.type === "subscriber-reply") {
    showStatus(
      "Reply reached the publisher through canReply. Teardown completes the exercise.",
      "success",
    );
  }
}

function handleStateMessage(event: MessageEvent<unknown>): void {
  const message = parseMessage(event.data);
  const revision = message.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision)) {
    appendLog(
      elements.stateLog,
      "received",
      String(event.data),
      "unexpected payload",
    );
    return;
  }
  if (revision <= latestAppliedStateRevision) {
    appendLog(
      elements.stateLog,
      "ignored",
      `revision ${revision}`,
      `older than applied revision ${latestAppliedStateRevision}`,
    );
    return;
  }
  latestAppliedStateRevision = revision;
  elements.latestRevision.textContent = String(revision);
  elements.latestPosition.textContent = String(message.x);
  appendLog(
    elements.stateLog,
    "received",
    `revision ${revision}`,
    `x=${String(message.x)}`,
  );
}

async function teardownExample(announce = true): Promise<void> {
  const currentTeardownManager = teardownManager;
  if (!currentTeardownManager) {
    if (announce) {
      showStatus(
        "Nothing has been created yet; teardown is already complete.",
        "neutral",
      );
    }
    return;
  }

  teardownRequested = true;
  phase = "closing";
  clearAcknowledgmentTimer();
  updateControls();
  if (announce) {
    showStatus(
      "Closing remote SFU DataChannels, then local DataChannels and PeerConnections...",
      "working",
    );
  }
  try {
    const result = await teardownAfterSetup(
      inFlightSetup,
      () => currentTeardownManager.teardown(),
    );
    phase = "closed";
    setGateState("closed");
    updateControls();
    if (announce) {
      showStatus(
        result.alreadyClosed
          ? "Teardown was already complete. No duplicate close requests were sent."
          : "Teardown complete. Message controls are stopped and both endpoints are closed.",
        "success",
      );
    }
  } catch (error) {
    phase = "error";
    updateControls();
    if (announce) {
      showError("Teardown needs another attempt", error);
    }
  }
}

function createResources(): Resources {
  return {
    publisher: null,
    subscriber: null,
    dataChannels: new Set<RTCDataChannel>(),
    peerConnections: new Set<RTCPeerConnection>(),
  };
}

function createTeardownManager(
  currentResources: Resources,
): TeardownManager {
  return new TeardownManager({
    api,
    getRemoteGroups() {
      const groups = [];
      for (const endpoint of [
        currentResources.publisher,
        currentResources.subscriber,
      ]) {
        if (endpoint) {
          groups.push({
            sessionId: endpoint.sessionId,
            channelIds: [...endpoint.channelIds],
          });
        }
      }
      return groups;
    },
    getDataChannels() {
      return [...currentResources.dataChannels];
    },
    getPeerConnections() {
      return [...currentResources.peerConnections];
    },
  });
}

function renderTeachingConfiguration(): void {
  for (const profileId of Object.keys(
    CHANNEL_PROFILES,
  ) as ChannelProfileId[]) {
    const profile = CHANNEL_PROFILES[profileId];
    const target = queryRequired<HTMLElement>(
      `[data-config="${profileId}"]`,
    );
    target.textContent = JSON.stringify(
      getProfileTeachingConfig(profileId),
      null,
      2,
    );
    queryRequired<HTMLElement>(
      `[data-description="${profileId}"]`,
    ).textContent = profile.description;
  }
}

function updateControls(): void {
  const connected = phase === "connected";
  const busy = phase === "connecting" || phase === "closing";
  elements.connectButton.disabled = busy || connected;
  elements.teardownButton.disabled = phase === "connecting";
  elements.probeButton.disabled =
    !connected ||
    probeSent ||
    acknowledgmentSent ||
    acknowledgmentExpired;
  const reliableAvailable =
    connected && acknowledgmentSent && !acknowledgmentExpired;
  elements.reliableInput.disabled = !reliableAvailable;
  elements.reliableButton.disabled = !reliableAvailable;
  elements.ackButton.disabled =
    !connected ||
    !probeSent ||
    acknowledgmentSent ||
    acknowledgmentExpired;
  const replyAvailable =
    connected &&
    acknowledgmentSent &&
    postAckMessageDelivered &&
    !acknowledgmentExpired;
  elements.replyInput.disabled = !replyAvailable;
  elements.replyButton.disabled = !replyAvailable;
  elements.stateButton.disabled = !connected;
}

function setConnectionBadge(
  role: EndpointRole,
  state: RTCPeerConnectionState,
): void {
  const badge =
    role === "publisher"
      ? elements.publisherConnection
      : elements.subscriberConnection;
  badge.textContent = state || "new";
  badge.dataset.state = state || "new";
}

function setChannelBadge(profileId: string, state: string): void {
  const badge = document.querySelector<HTMLElement>(
    `[data-channel-state="${profileId}"]`,
  );
  if (!badge) {
    return;
  }
  badge.textContent = state;
  badge.dataset.state = state;
}

function setGateState(state: "closed" | "open" | "expired"): void {
  elements.gateState.dataset.state = state;
  elements.gateState.textContent =
    state === "open"
      ? "gate open"
      : state === "expired"
        ? "gate expired"
        : "gate closed";
}

function startAcknowledgmentDeadline(
  remoteRequestStartedAt: number,
): void {
  acknowledgmentDeadline = remoteRequestStartedAt + 30_000;
  const remainingMs = acknowledgmentDeadline - Date.now();
  if (remainingMs <= 0) {
    expireAcknowledgment();
    return;
  }
  elements.ackDeadline.textContent =
    "The SFU allows 30 seconds from remote channel creation; send the ACK promptly.";
  acknowledgmentTimer = setTimeout(expireAcknowledgment, remainingMs);
}

function expireAcknowledgment(): void {
  if (acknowledgmentExpired) {
    return;
  }
  acknowledgmentExpired = true;
  clearAcknowledgmentTimer();
  elements.ackDeadline.textContent =
    "ACK window expired. Teardown and reconnect to retry.";
  setGateState("expired");
  updateControls();
  showStatus(
    "The waitForAck deadline expired, so the SFU tore down the gated remote channel. Teardown and reconnect.",
    "error",
  );
}

function clearAcknowledgmentTimer(): void {
  if (acknowledgmentTimer !== null) {
    clearTimeout(acknowledgmentTimer);
    acknowledgmentTimer = null;
  }
}

function showStatus(message: string, tone: StatusTone): void {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function showError(context: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  showStatus(`${context}: ${detail}`, "error");
}

function appendLog(
  list: HTMLOListElement,
  direction: string,
  message: string,
  detail = "",
): void {
  const item = document.createElement("li");
  const directionNode = document.createElement("span");
  const messageNode = document.createElement("strong");
  const detailNode = document.createElement("small");
  directionNode.className = "log-direction";
  directionNode.textContent = direction;
  messageNode.textContent = message;
  detailNode.textContent = detail;
  item.append(directionNode, messageNode, detailNode);
  list.prepend(item);
  while (list.children.length > 10) {
    list.lastElementChild?.remove();
  }
}

function clearLogs(): void {
  elements.publisherLog.replaceChildren();
  elements.subscriberLog.replaceChildren();
  elements.stateLog.replaceChildren();
  elements.latestRevision.textContent = "-";
  elements.latestPosition.textContent = "-";
  elements.reliableInput.value = "fresh message sent after ACK";
  elements.replyInput.value = "subscriber reply via canReply";
}

function requireMessage(value: string): string {
  const message = value.trim();
  if (message.length === 0 || message.length > 500) {
    throw new ExampleError(
      "invalid_message",
      "Enter a message from 1 through 500 characters.",
    );
  }
  return message;
}

function parseMessage(value: unknown): MessageRecord {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as MessageRecord)
      : {};
  } catch {
    return {};
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function requireResources(): Resources {
  if (!resources) {
    throw new ExampleError(
      "resources_not_ready",
      "Connect the example before using its DataChannels.",
    );
  }
  return resources;
}

function requireEndpoint(
  endpoint: Endpoint | null,
  role: EndpointRole,
): Endpoint {
  if (!endpoint) {
    throw new ExampleError(
      "endpoint_not_ready",
      `The ${role} endpoint has not been created.`,
    );
  }
  return endpoint;
}

function requireEndpointSessionId(endpoint: Endpoint): string {
  if (!endpoint.sessionId) {
    throw new ExampleError(
      "session_not_ready",
      `The ${endpoint.role} Realtime SFU session has not been created.`,
    );
  }
  return endpoint.sessionId;
}

function queryRequired<ElementType extends Element>(
  selector: string,
): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) {
    throw new Error(`Required page element is missing: ${selector}`);
  }
  return element;
}

function getElements(): Elements {
  return {
    connectButton: queryRequired<HTMLButtonElement>("#connect-button"),
    teardownButton: queryRequired<HTMLButtonElement>("#teardown-button"),
    status: queryRequired<HTMLParagraphElement>("#status"),
    publisherConnection: queryRequired<HTMLElement>(
      "#publisher-connection",
    ),
    subscriberConnection: queryRequired<HTMLElement>(
      "#subscriber-connection",
    ),
    reliableForm: queryRequired<HTMLFormElement>("#reliable-form"),
    reliableInput: queryRequired<HTMLInputElement>("#reliable-message"),
    reliableButton: queryRequired<HTMLButtonElement>("#send-reliable"),
    probeButton: queryRequired<HTMLButtonElement>("#send-probe"),
    probeStatus: queryRequired<HTMLParagraphElement>("#probe-status"),
    ackButton: queryRequired<HTMLButtonElement>("#send-ack"),
    ackDeadline: queryRequired<HTMLParagraphElement>("#ack-deadline"),
    gateState: queryRequired<HTMLElement>("#gate-state"),
    replyForm: queryRequired<HTMLFormElement>("#reply-form"),
    replyInput: queryRequired<HTMLInputElement>("#reply-message"),
    replyButton: queryRequired<HTMLButtonElement>("#send-reply"),
    stateButton: queryRequired<HTMLButtonElement>("#send-state-burst"),
    publisherLog: queryRequired<HTMLOListElement>("#publisher-log"),
    subscriberLog: queryRequired<HTMLOListElement>("#subscriber-log"),
    stateLog: queryRequired<HTMLOListElement>("#state-log"),
    latestRevision: queryRequired<HTMLElement>("#latest-revision"),
    latestPosition: queryRequired<HTMLElement>("#latest-position"),
  };
}
