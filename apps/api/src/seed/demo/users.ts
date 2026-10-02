import { eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import type { DemoState, DemoUser } from './state';

export const DEMO_PASSWORD = 'Demo@12345';

interface UserSeed {
  key: string;
  name: string;
  email: string;
  roleKey: string;
  teamKeys: string[];
  title: string;
  phone: string;
  timezone?: string;
}

export const MSP_USERS: UserSeed[] = [
  { key: 'ananya', name: 'Ananya Krishnan', email: 'ananya.krishnan@msp.local', roleKey: 'service_manager', teamKeys: ['service_desk'], title: 'Service Delivery Manager', phone: '+91 98100 11001' },
  { key: 'vikram', name: 'Vikram Mehta', email: 'vikram.mehta@msp.local', roleKey: 'account_manager', teamKeys: [], title: 'Account Manager', phone: '+91 98100 11002' },
  { key: 'rajesh', name: 'Rajesh Kumar', email: 'rajesh.kumar@msp.local', roleKey: 'noc_manager', teamKeys: ['noc', 'network', 'infra'], title: 'NOC Manager', phone: '+91 98100 11003' },
  { key: 'priya', name: 'Priya Sharma', email: 'priya.sharma@msp.local', roleKey: 'noc_engineer', teamKeys: ['noc', 'network'], title: 'Senior NOC Engineer (Network)', phone: '+91 98100 11004' },
  { key: 'arjun', name: 'Arjun Nair', email: 'arjun.nair@msp.local', roleKey: 'noc_engineer', teamKeys: ['noc', 'infra'], title: 'NOC Engineer (Servers & Storage)', phone: '+91 98100 11005' },
  { key: 'deepak', name: 'Deepak Verma', email: 'deepak.verma@msp.local', roleKey: 'noc_engineer', teamKeys: ['noc', 'cloud'], title: 'NOC Engineer (Cloud & Virtualization)', phone: '+91 98100 11006' },
  { key: 'sneha', name: 'Sneha Iyer', email: 'sneha.iyer@msp.local', roleKey: 'soc_manager', teamKeys: ['soc'], title: 'SOC Manager', phone: '+91 98100 11007' },
  { key: 'karan', name: 'Karan Malhotra', email: 'karan.malhotra@msp.local', roleKey: 'soc_analyst', teamKeys: ['soc'], title: 'SOC Analyst L2', phone: '+91 98100 11008' },
  { key: 'fatima', name: 'Fatima Siddiqui', email: 'fatima.siddiqui@msp.local', roleKey: 'soc_analyst', teamKeys: ['soc'], title: 'SOC Analyst L1', phone: '+91 98100 11009' },
  { key: 'rohan', name: 'Rohan Desai', email: 'rohan.desai@msp.local', roleKey: 'service_desk', teamKeys: ['service_desk'], title: 'Service Desk Engineer', phone: '+91 98100 11010' },
  { key: 'meera', name: 'Meera Pillai', email: 'meera.pillai@msp.local', roleKey: 'service_desk', teamKeys: ['service_desk'], title: 'Service Desk Engineer', phone: '+91 98100 11011' },
  { key: 'suresh', name: 'Suresh Reddy', email: 'suresh.reddy@msp.local', roleKey: 'engineer', teamKeys: ['field'], title: 'Field Engineer (North)', phone: '+91 98100 11012' },
  { key: 'amit', name: 'Amit Joshi', email: 'amit.joshi@msp.local', roleKey: 'engineer', teamKeys: ['field'], title: 'Field Engineer (West)', phone: '+91 98100 11013' },
  { key: 'neha', name: 'Neha Gupta', email: 'neha.gupta@msp.local', roleKey: 'engineer', teamKeys: ['field'], title: 'Field Engineer (South)', phone: '+91 98100 11014' },
  { key: 'daniel', name: 'Daniel Fernandes', email: 'daniel.fernandes@msp.local', roleKey: 'cmdb_admin', teamKeys: ['infra'], title: 'CMDB & Asset Administrator', phone: '+91 98100 11015' },
  { key: 'lakshmi', name: 'Lakshmi Narayanan', email: 'lakshmi.narayanan@msp.local', roleKey: 'contract_admin', teamKeys: [], title: 'Contracts Administrator', phone: '+91 98100 11016' },
  { key: 'sarah', name: 'Sarah Thompson', email: 'sarah.thompson@msp.local', roleKey: 'management', teamKeys: [], title: 'Head of Managed Services', phone: '+44 20 7946 0101', timezone: 'Europe/London' },
  { key: 'nikhil', name: 'Nikhil Bose', email: 'nikhil.bose@msp.local', roleKey: 'auditor', teamKeys: [], title: 'Internal Auditor', phone: '+91 98100 11018' },
];

/** Team managers (team key → user key). */
const TEAM_MANAGERS: Record<string, string> = { service_desk: 'ananya', noc: 'rajesh', network: 'rajesh', infra: 'rajesh', cloud: 'rajesh', soc: 'sneha', field: 'ananya' };

export async function seedUsers(state: DemoState, tx: Tx, passwordHash: string) {
  const { refs } = state;
  const rows = await tx
    .insert(schema.users)
    .values(
      MSP_USERS.map((u) => ({
        email: u.email,
        name: u.name,
        phone: u.phone,
        title: u.title,
        userType: 'msp' as const,
        status: 'active' as const,
        timezone: u.timezone ?? 'Asia/Kolkata',
        passwordHash,
        passwordChangedAt: state.now,
        lastLoginAt: new Date(state.now.getTime() - state.rng.int(1, 72) * 3_600_000),
      })),
    )
    .returning({ id: schema.users.id, email: schema.users.email });
  const idByEmail = new Map(rows.map((r) => [r.email, r.id]));
  for (const u of MSP_USERS) {
    const id = idByEmail.get(u.email)!;
    const du: DemoUser = { key: u.key, id, name: u.name, email: u.email, roleKey: u.roleKey, teamKeys: u.teamKeys, title: u.title };
    state.users.set(u.key, du);
  }
  await tx.insert(schema.userRoles).values(MSP_USERS.map((u) => ({ userId: state.users.get(u.key)!.id, roleId: refs.role(u.roleKey), customerId: null, createdBy: state.admin.id })));
  const members = MSP_USERS.flatMap((u) => u.teamKeys.map((t) => ({ teamId: refs.team(t), userId: state.users.get(u.key)!.id, isLead: TEAM_MANAGERS[t] === u.key })));
  await tx.insert(schema.teamMembers).values(members).onConflictDoNothing();
  for (const [teamKey, userKey] of Object.entries(TEAM_MANAGERS)) {
    await tx.update(schema.teams).set({ managerUserId: state.users.get(userKey)!.id, updatedAt: state.now }).where(eq(schema.teams.id, refs.team(teamKey)));
  }
  state.counts.users = (state.counts.users ?? 0) + rows.length;
}
