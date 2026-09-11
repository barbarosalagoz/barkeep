/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // The *.live.test.ts suites talk to the real mock anchor on Testnet.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
