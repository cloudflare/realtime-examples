import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createRoomController } from "./room-controller";
import "./styles.css";

const controller = createRoomController();
const container = document.getElementById("root");
if (!container) throw new Error("Missing #root.");

document.title = `${controller.roomId} · Realtime`;
createRoot(container).render(
  <StrictMode>
    <App controller={controller} />
  </StrictMode>,
);

// Resume belongs to page startup, not a component's mount/unmount cycle.
controller.resume();
