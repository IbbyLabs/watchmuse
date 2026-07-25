import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Every integration suite stands up its own PGlite instance and runs the
     * full migration set in `beforeAll`. Several of those booting at once on a
     * busy machine comfortably outruns the 10s default, and the migration set
     * only grows, so give setup and teardown real room.
     */
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
