import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      TABLE_NAME: "TeamHub-test",
      AWS_REGION: "us-east-1",
      CLUB_ID: "a5",
      CLUB_ADMIN_EMAILS: "club@example.com"
    },
    testTimeout: 20000,
    hookTimeout: 30000
  }
});
