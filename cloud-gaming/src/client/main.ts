import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { App } from "./app";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing cloud-gaming application root.");

createRoot(rootElement).render(createElement(App));
