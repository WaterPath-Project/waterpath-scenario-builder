/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        outfit: ["Outfit", "sans-serif"],
        inter: ["Inter", "sans-serif"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      colors: {
        wpGray: {
          100: "#EEF2F5",
        },
        wpBlue: {
          DEFAULT: "#0B4159",
          900: "#0D2834",
          800: "#143543",
          500: "#B7D7EF",
          300: "#096890",
          200: "#71AFCA",
          100: "#CAD8E3",
        },
        wpGreen: {
          DEFAULT: "#8DD0A4",
          900: "#9AE0A5",
          800: "#62B27D",
          700: "#6DF69C",
        },
        wpWhite: {
          DEFAULT: "#F6F9FB",
        },
        wpBrown: {
          DEFAULT: "#F2EFE6",
          900: "#BDA457",
          500: "#FFE597",
          200: "#F2EFE6",
          100: "#DDD6C2",
        },
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
