/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  // Staleness tone colors are chosen at runtime; Tailwind's JIT can't see them
  // in template literals, so safelist just the few we map to.
  safelist: ['text-slate-500', 'text-amber-600', 'text-rose-600'],
  plugins: [],
}
