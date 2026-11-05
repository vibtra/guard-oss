import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router";
import { App } from "./App";
import { basenameFromPath } from "./auth/return-to";
import "./index.css";

export { basenameFromPath };

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

const router = createBrowserRouter([{ path: "*", element: <App /> }], { basename: basenameFromPath(window.location.pathname) });

createRoot(root).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
