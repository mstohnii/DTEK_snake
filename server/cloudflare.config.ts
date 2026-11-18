import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/worker.js" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "dtek-snake-leaderboard",
		compatibilityDate: "2026-10-01",
		entrypoint,
		env: {
			// Created with `cf d1 create --name dtek-snake-leaderboard`.
			DB: bindings.d1({ id: "f454b354-7475-4649-8101-899920e23ee8", name: "dtek-snake-leaderboard" }),
			// HMAC key for run tickets: a long random string, uploaded as a secret.
			TOKEN_SECRET: bindings.secret(),
			// Comma-separated list of origins allowed to call the API.
			ALLOWED_ORIGINS: bindings.text("https://dtek.mstohnii.com,https://mstohnii.github.io,https://dtek.mstohnii.workers.dev,http://localhost:5173"),
		},
	},
});
