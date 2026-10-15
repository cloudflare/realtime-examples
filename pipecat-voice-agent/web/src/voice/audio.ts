export class CallAudio {
  readonly context = new AudioContext({ sampleRate: 48_000 });
  readonly outgoing = this.context.createMediaStreamDestination();
  private silence = this.context.createConstantSource();
  private microphone?: MediaStream;
  private input?: MediaStreamAudioSourceNode;
  private incoming?: MediaStreamAudioSourceNode;
  private playback?: HTMLAudioElement;
  private gate = this.context.createGain();
  private outputLevel = this.context.createAnalyser();
  private inputLevel = this.context.createAnalyser();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private captureStopped = false;
  hasRemoteAudio = false;
  playbackBlocked = false;

  async open(deviceId: string | undefined, onLevels: (user: number, agent: number) => void) {
    await this.context.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    // getUserMedia itself cannot be aborted. A late permission grant after
    // Stop must release the newly acquired tracks immediately.
    if (this.closed || this.captureStopped) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException('Call cancelled', 'AbortError');
    }
    this.microphone = stream;
    this.input = this.context.createMediaStreamSource(stream);
    this.input.connect(this.outgoing);
    this.input.connect(this.inputLevel);
    this.silence.offset.value = 0;
    this.silence.connect(this.outgoing);
    this.silence.start();
    this.gate.connect(this.outputLevel);
    this.outputLevel.connect(this.context.destination);
    this.inputLevel.fftSize = this.outputLevel.fftSize = 256;
    const samples = new Float32Array(256);
    const level = (analyser: AnalyserNode) => {
      analyser.getFloatTimeDomainData(samples);
      return Math.min(
        1,
        Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length) * 8,
      );
    };
    this.timer = setInterval(() => onLevels(level(this.inputLevel), level(this.outputLevel)), 100);
  }

  async receive(track: MediaStreamTrack) {
    if (this.closed) return;
    this.incoming?.disconnect();
    const stream = new MediaStream([track]);
    // Explicitly start the receiver's media element. Chrome can receive RTP
    // without advancing playout when only a Web Audio source is attached.
    this.playback?.pause();
    this.playback?.remove();
    const playback = document.createElement('audio');
    playback.autoplay = true;
    playback.volume = 0;
    playback.hidden = true;
    playback.srcObject = stream;
    document.body.append(playback);
    this.playback = playback;
    this.incoming = this.context.createMediaStreamSource(stream);
    this.incoming.connect(this.gate);
    this.hasRemoteAudio = true;
    try {
      await playback.play();
    } catch {
      if (!this.closed) this.playbackBlocked = true;
    }
  }

  muteMicrophone(muted: boolean) {
    this.microphone?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  setPlayback(enabled: boolean) {
    if (!this.closed) this.gate.gain.setValueAtTime(enabled ? 1 : 0, this.context.currentTime);
  }

  async resume() {
    if (!this.closed) {
      await this.context.resume();
      await this.playback?.play();
      this.playbackBlocked = false;
    }
  }

  async close() {
    if (this.closed) return;
    this.stopCapture();
    this.closed = true;
    this.outgoing.stream.getTracks().forEach((track) => track.stop());
    try {
      this.silence.stop();
    } catch {
      /* It may not have started. */
    }
    this.input?.disconnect();
    this.incoming?.disconnect();
    if (this.playback) {
      this.playback.pause();
      this.playback.srcObject = null;
      this.playback.remove();
    }
    if (this.context.state !== 'closed') await this.context.close();
  }

  stopCapture() {
    this.captureStopped = true;
    this.setPlayback(false);
    clearInterval(this.timer);
    this.microphone?.getTracks().forEach((track) => track.stop());
    this.input?.disconnect();
  }
}
