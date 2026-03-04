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
        sm: "4px",
        md: "2px",
        lg: "8px",
        xl: "16px"
      },
      colors: {
        wpGray: {
          100: "#EEF2F5",
          200: "#F6F9FB",
          300: "#F1F4FA",
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
          100: "#FFFFFF"
        },
        wpBrown: {
          DEFAULT: "#F2EFE6",
          900: "#BDA457",
          500: "#FFE597",
          200: "#F2EFE6",
          100: "#DDD6C2",
        },
        wpTeal: {
          DEFAULT: "#18B6A3",
          100: "#d0f5f1",
          200: "#a1ebe3",
        },
        wpCypress: {
          DEFAULT: "#9EB65B",
          100: "#edf3d9",
          200: "#d5e7a8",
        },
        wpLightBlue: {
          DEFAULT: "#488ECF",
          100: "#dceaf7",
          200: "#b8d5ef",
        },
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
