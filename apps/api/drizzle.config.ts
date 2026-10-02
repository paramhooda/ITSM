import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/*.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_ADMIN_URL ?? 'postgres://itsm:itsm@localhost:5432/itsm',
  },
  strict: true,
  verbose: false,
});
