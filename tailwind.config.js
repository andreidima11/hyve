/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './templates/**/*.html',
    './static/js/**/*.{js,ts}',
    './static/hyveview/**/*.ts',
  ],
  theme: {
    extend: {
      colors: {
        bg: { main: '#030712', card: '#0f172a', side: '#010409' },
        accent: { DEFAULT: '#38bdf8', hover: '#7dd3fc', muted: '#0284c7' },
      },
    },
  },
  plugins: [],
};
