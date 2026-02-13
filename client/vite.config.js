import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Simple Vite config; /ide is now handled entirely by the React app,
// and the embedded IDE talks directly to http://localhost:3100 via iframe.
export default defineConfig({
  plugins: [react()],
})
