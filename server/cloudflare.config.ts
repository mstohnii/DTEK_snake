import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/worker.js" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "dtek-snake-leaderboard",
		compatibilityDate: "2026-10-01",
		entrypoint,
		env: {
			// Created with `cf d1 create`; put the database id here before deploying.
			DB: bindings.d1({ name: "dtek-snake-leaderboard" }),
			// HMAC key for run tickets: a long random string, uploaded as a secret.
			TOKEN_SECRET: bindings.secret(),
			// Comma-separated list of origins allowed to call the API.
			ALLOWED_ORIGINS: bindings.text("https://mstohnii.github.io,http://localhost:5173"),
		},
	},
});
