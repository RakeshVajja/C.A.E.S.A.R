import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests never read the developer's .env values for these keys; dotenv does not override them.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost:5432/cse_research_hub_test?schema=public',
      CORS_ORIGIN: 'http://localhost:3000',
    },
  },
});
