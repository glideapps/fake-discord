import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    base: process.env["VITE_BASE"] || "/",
    plugins: [tailwindcss(), react()],
    build: {
        outDir: "dist/client",
        emptyOutDir: true,
    },
    server: {
        port: 5173,
        watch: {
            ignored: ["**/.fling/**"],
        },
        proxy: {
            "/api": {
                target: "http://localhost:3210",
                changeOrigin: true,
            },
            "/_test": {
                target: "http://localhost:3210",
                changeOrigin: true,
            },
            "/oauth2": {
                target: "http://localhost:3210",
                changeOrigin: true,
            },
        },
    },
});
