import { Hono } from "hono";
import { apiRoutes } from "../api/index.js";

export const navidromeRoutes = new Hono();
navidromeRoutes.route("/", apiRoutes);
