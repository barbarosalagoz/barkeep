/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { thirdPartyLicenses } from './build/third-party-licenses.ts'

// https://vite.dev/config/
export default defineConfig({
  // thirdPartyLicenses() emits /third-party-licenses.txt and fails the build
  // on non-permissive or unlicensed bundled packages.
  plugins: [react(), ...thirdPartyLicenses()],
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'build/**/*.test.ts'],
    // The *.live.test.ts suites talk to the real mock anchor on Testnet.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
