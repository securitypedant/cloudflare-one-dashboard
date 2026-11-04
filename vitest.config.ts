import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so unit tests don't start the Cloudflare Vite plugin / workerd.
export default defineConfig({
	test: {
		include: ["worker/**/*.test.ts", "src/**/*.test.ts"],
	},
});
