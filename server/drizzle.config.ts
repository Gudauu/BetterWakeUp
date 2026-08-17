import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  // Never let the kit reshape a database on its own; every change is a
  // reviewed migration file.
  strict: true,
  verbose: true,
});
