/**
 * FreeCode desktop palette. Kept so the UI can be built with Tailwind later;
 * the shipped stylesheet in public/styles.css mirrors these exact values.
 *
 *   primary #00FF88   background #0A0A0A   sidebar #0A0A0A
 *   button  #00FF88   active border #00FF88
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './public/**/*.{js,html}'],
  theme: {
    extend: {
      colors: {
        primary: '#00FF88',
        'primary-dim': '#00B862',
        background: '#0A0A0A',
        sidebar: '#0A0A0A',
        panel: '#1A1A1A',
        button: '#00FF88',
        border: '#00FF88',
        'active-border': '#00FF88',
        text: '#E8E8E8',
        muted: '#7A7A7A',
        danger: '#FF4D4D',
        warn: '#FFC24D',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Cascadia Mono', 'Consolas', 'monospace'],
      },
      borderRadius: {
        xl2: '1.25rem',
      },
      boxShadow: {
        glow: '0 0 0 1px #00FF88, 0 0 24px rgba(0, 255, 136, 0.18)',
      },
    },
  },
  plugins: [],
};
