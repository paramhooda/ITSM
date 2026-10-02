/** Realistic demonstration dataset (customers, sites, contracts, assets, CIs, tickets...). */
export async function seedDemo() {
  // Implemented in src/seed/demo-data.ts (loaded lazily to keep startup fast).
  const mod = await import('./demo-data');
  await mod.loadDemoData();
}
