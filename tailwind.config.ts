import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0a0a0a",
          elevated: "#0d0d0d",
          card: "#141414"
        },
        line: "#1f1f1f",
        text: {
          DEFAULT: "#f5f5f5",
          muted: "#9ca3af",
          subtle: "#6b7280"
        },
        rose: {
          accent: "#ff4d6d",
          hover: "#ff6b85"
        }
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"]
      },
      letterSpacing: {
        wider: "0.05em",
        widest: "0.1em"
      },
      transitionDuration: {
        micro: "75ms"
      }
    }
  },
  plugins: []
};

export default config;
