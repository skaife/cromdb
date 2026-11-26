import "@fontsource-variable/inter/wght.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/screens.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { App } from "./app/App.tsx";
import { pageRoutes } from "./app/routes.tsx";

const router = createBrowserRouter(pageRoutes(<App />));

const root = document.getElementById("root");
if (root === null) throw new Error("The page has no #root");
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
