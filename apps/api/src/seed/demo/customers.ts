import { eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { createCustomer } from '@/modules/customers/service';
import { createSite } from '@/modules/customers/sites';
import { createContact } from '@/modules/customers/contacts';
import { adminCtx, type DemoCustomer, type DemoState } from './state';

interface SiteSeed {
  key: string;
  code: string;
  name: string;
  typeKey: string;
  size: 'large' | 'small';
  city: string;
  state: string;
  line1: string;
}

interface ContactSeed {
  name: string;
  title: string;
  department: string;
  isPrimary?: boolean;
  escalationLevel?: number;
  portal?: 'customer_admin' | 'customer_user';
  siteKey?: string;
}

interface CustomerSeed {
  key: string;
  code: string;
  name: string;
  legalName: string;
  short: string;
  emailDomain: string;
  industryKey: string;
  typeKey: string;
  statusKey?: string;
  timezone: string;
  website: string;
  phone: string;
  tags: string[];
  notes: string;
  domains: DemoCustomer['domains'];
  sites: SiteSeed[];
  contacts: ContactSeed[];
  fieldEngineerKeys: string[];
  teamKeys: string[];
}

const IN = (city: string, state: string, line1: string, pin: string) => ({ line1, city, state, postalCode: pin, country: 'India' });

export const CUSTOMER_SEEDS: CustomerSeed[] = [
  {
    key: 'abc', code: 'ABC', name: 'ABC Manufacturing', legalName: 'ABC Manufacturing Industries Pvt. Ltd.', short: 'abc', emailDomain: 'abc-manufacturing.example', industryKey: 'manufacturing', typeKey: 'enterprise', timezone: 'Asia/Kolkata', website: 'https://www.abc-manufacturing.example', phone: '+91 124 456 7000',
    tags: ['strategic', 'manufacturing', 'north'], notes: 'Two plants running 3 shifts; production network changes require plant head approval. Monthly service review on the first Tuesday.',
    domains: { soc: false, amc: true, cloud: false, eus: false },
    sites: [
      { key: 'gur', code: 'GUR', name: 'Gurgaon Plant', typeKey: 'plant', size: 'large', city: 'Gurgaon', state: 'Haryana', line1: 'Plot 42, Sector 37, Industrial Area' },
      { key: 'pun', code: 'PUN', name: 'Pune Plant', typeKey: 'plant', size: 'large', city: 'Pune', state: 'Maharashtra', line1: 'Gat No. 118, Chakan MIDC Phase II' },
      { key: 'che', code: 'CHE', name: 'Chennai Office', typeKey: 'office', size: 'small', city: 'Chennai', state: 'Tamil Nadu', line1: '3rd Floor, Olympia Tech Park, Guindy' },
      { key: 'hq', code: 'HQ', name: 'Corporate Office Delhi', typeKey: 'corporate_hq', size: 'small', city: 'New Delhi', state: 'Delhi', line1: 'Tower B, DLF Cyber City' },
    ],
    contacts: [
      { name: 'Manish Agarwal', title: 'IT Manager', department: 'Information Technology', isPrimary: true, escalationLevel: 1, portal: 'customer_admin', siteKey: 'hq' },
      { name: 'Ritu Saxena', title: 'Head of IT Infrastructure', department: 'Information Technology', escalationLevel: 2, portal: 'customer_user', siteKey: 'hq' },
      { name: 'Sanjay Bhatt', title: 'Plant Head', department: 'Operations', siteKey: 'gur' },
      { name: 'Pooja Deshmukh', title: 'IT Executive', department: 'Information Technology', portal: 'customer_user', siteKey: 'pun' },
      { name: 'Harish Menon', title: 'Finance Controller', department: 'Finance', siteKey: 'hq' },
    ],
    fieldEngineerKeys: ['suresh', 'neha'], teamKeys: ['noc', 'service_desk', 'field'],
  },
  {
    key: 'meridian', code: 'MERIDIAN', name: 'Meridian Bank', legalName: 'Meridian Bank Limited', short: 'mrd', emailDomain: 'meridianbank.example', industryKey: 'bfsi', typeKey: 'strategic', timezone: 'Asia/Kolkata', website: 'https://www.meridianbank.example', phone: '+91 22 6789 1000',
    tags: ['strategic', 'bfsi', 'premium-sla', 'regulated'], notes: 'Regulated entity: all changes to DR site need CAB approval and a change window outside banking hours. Quarterly RBI audit evidence required.',
    domains: { soc: true, amc: false, cloud: false, eus: false },
    sites: [
      { key: 'hq', code: 'HQ', name: 'Head Office Mumbai', typeKey: 'corporate_hq', size: 'large', city: 'Mumbai', state: 'Maharashtra', line1: 'Meridian House, Bandra Kurla Complex' },
      { key: 'dr', code: 'DR', name: 'DR Site Pune', typeKey: 'data_center', size: 'large', city: 'Pune', state: 'Maharashtra', line1: 'Rack Row C, STT Data Center, Hinjewadi' },
      { key: 'and', code: 'BR-AND', name: 'Branch Andheri', typeKey: 'branch', size: 'small', city: 'Mumbai', state: 'Maharashtra', line1: 'Shop 4, Link Road, Andheri West' },
      { key: 'ban', code: 'BR-BAN', name: 'Branch Bandra', typeKey: 'branch', size: 'small', city: 'Mumbai', state: 'Maharashtra', line1: 'Hill Road, Bandra West' },
      { key: 'tha', code: 'BR-THA', name: 'Branch Thane', typeKey: 'branch', size: 'small', city: 'Thane', state: 'Maharashtra', line1: 'Ghodbunder Road, Thane West' },
    ],
    contacts: [
      { name: 'Rakesh Chandra', title: 'Chief Information Officer', department: 'Technology', escalationLevel: 2, siteKey: 'hq' },
      { name: 'Divya Raghavan', title: 'Head of IT Operations', department: 'Technology', isPrimary: true, escalationLevel: 1, portal: 'customer_admin', siteKey: 'hq' },
      { name: 'Imran Shaikh', title: 'Information Security Officer', department: 'Information Security', portal: 'customer_user', siteKey: 'hq' },
      { name: 'Kavita Joshi', title: 'DR Site Coordinator', department: 'Technology', portal: 'customer_user', siteKey: 'dr' },
    ],
    fieldEngineerKeys: ['neha'], teamKeys: ['noc', 'service_desk', 'soc'],
  },
  {
    key: 'northwind', code: 'NWP', name: 'Northwind Pharma', legalName: 'Northwind Pharmaceuticals Ltd.', short: 'nwp', emailDomain: 'northwindpharma.example', industryKey: 'pharma', typeKey: 'mid_market', timezone: 'Asia/Kolkata', website: 'https://www.northwindpharma.example', phone: '+91 40 2345 6700',
    tags: ['pharma', 'gxp', 'south'], notes: 'GxP validated environment: server changes in the manufacturing VLAN need QA sign-off and a validation record.',
    domains: { soc: false, amc: true, cloud: false, eus: false },
    sites: [
      { key: 'plant', code: 'HYD-PLANT', name: 'Hyderabad Plant', typeKey: 'plant', size: 'large', city: 'Hyderabad', state: 'Telangana', line1: 'Survey 12, Jeedimetla Industrial Area' },
      { key: 'rnd', code: 'HYD-RND', name: 'Hyderabad R&D Office', typeKey: 'office', size: 'small', city: 'Hyderabad', state: 'Telangana', line1: 'Genome Valley, Shamirpet' },
    ],
    contacts: [
      { name: 'Venkat Rao', title: 'IT Head', department: 'Information Technology', isPrimary: true, escalationLevel: 1, portal: 'customer_admin', siteKey: 'plant' },
      { name: 'Anjali Mishra', title: 'QA Manager', department: 'Quality Assurance', escalationLevel: 2, siteKey: 'plant' },
      { name: 'Srinivas Kolli', title: 'System Administrator', department: 'Information Technology', portal: 'customer_user', siteKey: 'rnd' },
    ],
    fieldEngineerKeys: ['suresh', 'neha'], teamKeys: ['noc', 'service_desk', 'field'],
  },
  {
    key: 'apex', code: 'APEX', name: 'Apex Retail', legalName: 'Apex Retail Ventures Pvt. Ltd.', short: 'apx', emailDomain: 'apexretail.example', industryKey: 'retail', typeKey: 'enterprise', timezone: 'Asia/Kolkata', website: 'https://www.apexretail.example', phone: '+91 80 4567 8900',
    tags: ['retail', 'multi-site', 'pos'], notes: 'Store POS outages are revenue impacting; stores open 10:00-22:00 including weekends. Network support contract up for renewal.',
    domains: { soc: false, amc: false, cloud: false, eus: true },
    sites: [
      { key: 'ho', code: 'HO', name: 'Head Office Bengaluru', typeKey: 'corporate_hq', size: 'large', city: 'Bengaluru', state: 'Karnataka', line1: 'Prestige Tech Park, Outer Ring Road' },
      { key: 'kor', code: 'ST-KOR', name: 'Store Koramangala', typeKey: 'branch', size: 'small', city: 'Bengaluru', state: 'Karnataka', line1: '80 Feet Road, Koramangala 4th Block' },
      { key: 'ind', code: 'ST-IND', name: 'Store Indiranagar', typeKey: 'branch', size: 'small', city: 'Bengaluru', state: 'Karnataka', line1: '100 Feet Road, Indiranagar' },
      { key: 'whf', code: 'ST-WHF', name: 'Store Whitefield', typeKey: 'branch', size: 'small', city: 'Bengaluru', state: 'Karnataka', line1: 'Phoenix Marketcity, Whitefield' },
      { key: 'hsr', code: 'ST-HSR', name: 'Store HSR Layout', typeKey: 'branch', size: 'small', city: 'Bengaluru', state: 'Karnataka', line1: '27th Main, HSR Layout Sector 1' },
      { key: 'jay', code: 'ST-JAY', name: 'Store Jayanagar', typeKey: 'branch', size: 'small', city: 'Bengaluru', state: 'Karnataka', line1: '11th Main, Jayanagar 4th Block' },
    ],
    contacts: [
      { name: 'Nandini Rao', title: 'Head of Technology', department: 'Technology', isPrimary: true, escalationLevel: 1, portal: 'customer_admin', siteKey: 'ho' },
      { name: 'Prakash Shetty', title: 'Store Operations Manager', department: 'Retail Operations', escalationLevel: 2, portal: 'customer_user', siteKey: 'ho' },
      { name: 'Aarti Kulkarni', title: 'IT Support Lead', department: 'Technology', portal: 'customer_user', siteKey: 'ho' },
      { name: 'Mohan Das', title: 'Store Manager', department: 'Retail Operations', siteKey: 'kor' },
    ],
    fieldEngineerKeys: ['amit'], teamKeys: ['noc', 'service_desk'],
  },
  {
    key: 'helios', code: 'HELIOS', name: 'Helios Energy', legalName: 'Helios Energy Corporation Ltd.', short: 'hel', emailDomain: 'heliosenergy.example', industryKey: 'energy', typeKey: 'government', timezone: 'Asia/Kolkata', website: 'https://www.heliosenergy.example', phone: '+91 120 456 7800',
    tags: ['energy', 'psu', 'ot-network'], notes: 'PSU with tender-based procurement. OT network at the solar park is air-gapped; only the corporate IT segment is in scope.',
    domains: { soc: false, amc: true, cloud: false, eus: false },
    sites: [
      { key: 'noida', code: 'NOIDA', name: 'Corporate Office Noida', typeKey: 'corporate_hq', size: 'large', city: 'Noida', state: 'Uttar Pradesh', line1: 'Sector 62, Noida' },
      { key: 'jsm', code: 'JSM', name: 'Solar Park Jaisalmer', typeKey: 'plant', size: 'small', city: 'Jaisalmer', state: 'Rajasthan', line1: 'Bhadla Solar Park, Phase III' },
      { key: 'cc', code: 'CC', name: 'Control Center Jaipur', typeKey: 'office', size: 'small', city: 'Jaipur', state: 'Rajasthan', line1: 'Vidyut Bhawan, Janpath' },
    ],
    contacts: [
      { name: 'Alok Pandey', title: 'DGM (IT)', department: 'Information Technology', isPrimary: true, escalationLevel: 1, portal: 'customer_admin', siteKey: 'noida' },
      { name: 'Sunita Yadav', title: 'Manager (IT Infrastructure)', department: 'Information Technology', escalationLevel: 2, portal: 'customer_user', siteKey: 'noida' },
      { name: 'Rajendra Singh', title: 'Site In-charge', department: 'Operations', siteKey: 'jsm' },
    ],
    fieldEngineerKeys: ['suresh'], teamKeys: ['noc', 'service_desk', 'field'],
  },
  {
    key: 'sterling', code: 'STERLING', name: 'Sterling Hospitals', legalName: 'Sterling Healthcare Pvt. Ltd.', short: 'stl', emailDomain: 'sterlinghospitals.example', industryKey: 'healthcare', typeKey: 'enterprise', timezone: 'Asia/Kolkata', website: 'https://www.sterlinghospitals.example', phone: '+91 44 2811 9000',
    tags: ['healthcare', '24x7', 'his'], notes: '24x7 hospital; HIS and PACS are life-critical. Maintenance windows only 02:00-05:00 with ICU sign-off.',
    domains: { soc: true, amc: true, cloud: false, eus: false },
    sites: [
      { key: 'main', code: 'MAIN', name: 'Main Hospital Chennai', typeKey: 'corporate_hq', size: 'large', city: 'Chennai', state: 'Tamil Nadu', line1: '12 Poonamallee High Road, Kilpauk' },
      { key: 'adyar', code: 'ADYAR', name: 'Clinic Adyar', typeKey: 'branch', size: 'small', city: 'Chennai', state: 'Tamil Nadu', line1: 'LB Road, Adyar' },
    ],
    contacts: [
      { name: 'Dr. Meenakshi Sundaram', title: 'Chief Operating Officer', department: 'Administration', escalationLevel: 2, siteKey: 'main' },
      { name: 'George Thomas', title: 'IT Manager', department: 'Information Technology', isPrimary: true, escalationLevel: 1, portal: 'customer_admin', siteKey: 'main' },
      { name: 'Lavanya Krishnan', title: 'Biomedical & IT Coordinator', department: 'Information Technology', portal: 'customer_user', siteKey: 'main' },
      { name: 'Arun Prasad', title: 'Clinic Administrator', department: 'Administration', siteKey: 'adyar' },
    ],
    fieldEngineerKeys: ['neha', 'suresh'], teamKeys: ['noc', 'service_desk', 'soc', 'field'],
  },
  {
    key: 'orbital', code: 'ORBITAL', name: 'Orbital Logistics', legalName: 'Orbital Logistics & Freight Pvt. Ltd.', short: 'orb', emailDomain: 'orbitallogistics.example', industryKey: 'logistics', typeKey: 'mid_market', timezone: 'Asia/Kolkata', website: 'https://www.orbitallogistics.example', phone: '+91 22 4000 5500',
    tags: ['logistics', 'aws', 'warehouse'], notes: 'WMS runs on AWS (ap-south-1). Warehouses operate 06:00-23:00; handheld scanners depend on warehouse Wi-Fi.',
    domains: { soc: false, amc: true, cloud: true, eus: false },
    sites: [
      { key: 'hq', code: 'HQ', name: 'Head Office Mumbai', typeKey: 'corporate_hq', size: 'large', city: 'Mumbai', state: 'Maharashtra', line1: 'Logistics Park, Andheri East' },
      { key: 'bhi', code: 'WH-BHI', name: 'Warehouse Bhiwandi', typeKey: 'warehouse', size: 'small', city: 'Bhiwandi', state: 'Maharashtra', line1: 'Gala 7-9, Mankoli Naka' },
      { key: 'nag', code: 'WH-NAG', name: 'Warehouse Nagpur', typeKey: 'warehouse', size: 'small', city: 'Nagpur', state: 'Maharashtra', line1: 'MIHAN SEZ, Plot 21' },
    ],
    contacts: [
      { name: 'Farhan Khan', title: 'IT Manager', department: 'Information Technology', isPrimary: true, escalationLevel: 1, portal: 'customer_admin', siteKey: 'hq' },
      { name: 'Sheetal Patil', title: 'Operations Director', department: 'Operations', escalationLevel: 2, siteKey: 'hq' },
      { name: 'Vinod Tiwari', title: 'Warehouse Supervisor', department: 'Operations', portal: 'customer_user', siteKey: 'bhi' },
    ],
    fieldEngineerKeys: ['amit'], teamKeys: ['noc', 'service_desk', 'field', 'cloud'],
  },
  {
    key: 'quantum', code: 'QUANTUM', name: 'Quantum IT Services', legalName: 'Quantum IT Services Pvt. Ltd.', short: 'qit', emailDomain: 'quantumit.example', industryKey: 'it_services', typeKey: 'mid_market', timezone: 'Asia/Kolkata', website: 'https://www.quantumit.example', phone: '+91 80 6789 1200',
    tags: ['it-services', 'azure', 'soc'], notes: 'ISO 27001 certified; SOC reports feed their customer audits. Azure landing zone managed under cloud support contract.',
    domains: { soc: true, amc: false, cloud: true, eus: false },
    sites: [
      { key: 'blr', code: 'BLR', name: 'Office Bengaluru', typeKey: 'corporate_hq', size: 'large', city: 'Bengaluru', state: 'Karnataka', line1: 'Embassy Golf Links, Domlur' },
      { key: 'pune', code: 'PUNE', name: 'Office Pune', typeKey: 'office', size: 'small', city: 'Pune', state: 'Maharashtra', line1: 'EON IT Park, Kharadi' },
    ],
    contacts: [
      { name: 'Siddharth Jain', title: 'CTO', department: 'Technology', escalationLevel: 2, siteKey: 'blr' },
      { name: 'Rhea Kapoor', title: 'Infrastructure Lead', department: 'Technology', isPrimary: true, escalationLevel: 1, portal: 'customer_admin', siteKey: 'blr' },
      { name: 'Abhishek Sen', title: 'Security Engineer', department: 'Information Security', portal: 'customer_user', siteKey: 'blr' },
    ],
    fieldEngineerKeys: ['neha'], teamKeys: ['noc', 'service_desk', 'soc', 'cloud'],
  },
  {
    key: 'riverside', code: 'RIVERSIDE', name: 'Riverside University', legalName: 'Riverside University Trust', short: 'rvu', emailDomain: 'riverside-univ.example', industryKey: 'education', typeKey: 'smb', timezone: 'Asia/Kolkata', website: 'https://www.riverside-univ.example', phone: '+91 141 270 3300',
    tags: ['education', 'campus-wifi'], notes: 'Semester start (July/January) brings peak Wi-Fi onboarding tickets. Student laptops are out of scope.',
    domains: { soc: false, amc: false, cloud: false, eus: false },
    sites: [
      { key: 'campus', code: 'CAMPUS', name: 'Main Campus', typeKey: 'corporate_hq', size: 'large', city: 'Jaipur', state: 'Rajasthan', line1: 'Riverside Campus, Tonk Road' },
      { key: 'hostel', code: 'HOSTEL', name: 'Hostel Block', typeKey: 'office', size: 'small', city: 'Jaipur', state: 'Rajasthan', line1: 'Hostel Block C, Riverside Campus' },
      { key: 'library', code: 'LIB', name: 'Central Library', typeKey: 'office', size: 'small', city: 'Jaipur', state: 'Rajasthan', line1: 'Central Library Building, Riverside Campus' },
    ],
    contacts: [
      { name: 'Prof. Anil Bhargava', title: 'Dean of IT', department: 'Information Technology', escalationLevel: 2, siteKey: 'campus' },
      { name: 'Shalini Chauhan', title: 'Network Administrator', department: 'Information Technology', isPrimary: true, escalationLevel: 1, portal: 'customer_admin', siteKey: 'campus' },
      { name: 'Rahul Meena', title: 'Help Desk Coordinator', department: 'Information Technology', portal: 'customer_user', siteKey: 'campus' },
    ],
    fieldEngineerKeys: ['amit'], teamKeys: ['noc', 'service_desk'],
  },
  {
    key: 'crestline', code: 'CRESTLINE', name: 'Crestline Hotels', legalName: 'Crestline Hotels Group Ltd.', short: 'crl', emailDomain: 'crestlinehotels.example', industryKey: 'other', typeKey: 'mid_market', timezone: 'Europe/London', website: 'https://www.crestlinehotels.example', phone: '+44 20 7946 0200',
    tags: ['hospitality', 'uk', 'international'], notes: 'UK-based hotel group supported from India on UK business hours. Property management system (Opera) is hosted at head office.',
    domains: { soc: false, amc: false, cloud: false, eus: false },
    sites: [
      { key: 'lon', code: 'LON', name: 'London Head Office', typeKey: 'corporate_hq', size: 'large', city: 'London', state: 'Greater London', line1: '48 Grosvenor Street, Mayfair' },
      { key: 'edi', code: 'EDI', name: 'Crestline Edinburgh', typeKey: 'branch', size: 'small', city: 'Edinburgh', state: 'Scotland', line1: '15 Princes Street' },
      { key: 'man', code: 'MAN', name: 'Crestline Manchester', typeKey: 'branch', size: 'small', city: 'Manchester', state: 'England', line1: '101 Deansgate' },
    ],
    contacts: [
      { name: 'James Whitfield', title: 'Group IT Director', department: 'Information Technology', isPrimary: true, escalationLevel: 1, portal: 'customer_admin', siteKey: 'lon' },
      { name: 'Emily Carter', title: 'IT Support Analyst', department: 'Information Technology', escalationLevel: 2, portal: 'customer_user', siteKey: 'lon' },
      { name: 'Oliver Grant', title: 'Hotel Manager', department: 'Operations', siteKey: 'edi' },
    ],
    fieldEngineerKeys: [], teamKeys: ['noc', 'service_desk'],
  },
];

const emailOf = (name: string, domain: string) =>
  `${name.toLowerCase().replace(/^(dr|prof)\.?\s+/, '').replace(/[^a-z\s]/g, '').trim().split(/\s+/).join('.')}@${domain}`;

export async function seedCustomers(state: DemoState, tx: Tx, passwordHash: string) {
  const { refs, rng } = state;
  const ctx = adminCtx(state, tx);
  const am = state.users.get('vikram')!;
  let index = 0;
  for (const seed of CUSTOMER_SEEDS) {
    index++;
    const uk = seed.timezone === 'Europe/London';
    const addr = uk
      ? { line1: seed.sites[0]!.line1, city: seed.sites[0]!.city, country: 'United Kingdom', postalCode: 'W1K 3HW' }
      : IN(seed.sites[0]!.city, seed.sites[0]!.state, seed.sites[0]!.line1, `${rng.int(110000, 699999)}`);
    const created = await createCustomer(ctx, {
      code: seed.code,
      name: seed.name,
      legalName: seed.legalName,
      industryId: refs.option('customer_industry', seed.industryKey),
      typeId: refs.option('customer_type', seed.typeKey),
      statusId: refs.option('customer_status', seed.statusKey ?? 'active'),
      accountManagerId: am.id,
      website: seed.website,
      phone: seed.phone,
      email: `it.helpdesk@${seed.emailDomain}`,
      address: addr,
      timezone: seed.timezone,
      notes: seed.notes,
      tags: seed.tags,
      customFields: { serviceReviewCadence: seed.typeKey === 'strategic' ? 'monthly' : 'quarterly', onboardedOn: '2025-01-15' },
    });
    const cust: DemoCustomer = {
      key: seed.key,
      id: created.id,
      code: seed.code,
      name: seed.name,
      short: seed.short,
      industryKey: seed.industryKey,
      timezone: seed.timezone,
      index,
      domains: seed.domains,
      sites: [],
      contacts: [],
      portalUsers: [],
      contracts: [],
      fieldEngineerKeys: seed.fieldEngineerKeys,
      cis: [],
      assets: [],
    };
    let subnet = 0;
    for (const s of seed.sites) {
      subnet++;
      const site = await createSite(ctx, cust.id, {
        code: s.code,
        name: s.name,
        typeId: refs.option('site_type', s.typeKey),
        address: uk ? { line1: s.line1, city: s.city, country: 'United Kingdom' } : IN(s.city, s.state, s.line1, `${rng.int(110000, 699999)}`),
        timezone: seed.timezone,
        phone: seed.phone,
        isPrimary: subnet === 1,
        notes: s.size === 'large' ? 'Server room with 2 racks, dual UPS, access controlled (badge + visitor log).' : 'Network cabinet in back office; no dedicated server room.',
      });
      cust.sites.push({ key: s.key, id: site.id, code: s.code, name: s.name, typeKey: s.typeKey, size: s.size, subnet });
    }
    for (const c of seed.contacts) {
      const site = c.siteKey ? cust.sites.find((x) => x.key === c.siteKey) : undefined;
      const email = emailOf(c.name, seed.emailDomain);
      const row = await createContact(ctx, cust.id, {
        name: c.name,
        title: c.title,
        department: c.department,
        email,
        phone: uk ? `+44 20 7946 ${rng.int(1000, 9999)}` : `+91 ${rng.int(70000, 99999)} ${rng.int(10000, 99999)}`,
        mobile: uk ? `+44 7700 ${rng.int(100000, 999999)}` : `+91 ${rng.int(70000, 99999)} ${rng.int(10000, 99999)}`,
        siteId: site?.id ?? null,
        isPrimary: !!c.isPrimary,
        isEscalation: !!c.escalationLevel,
        escalationLevel: c.escalationLevel ?? null,
        notes: c.escalationLevel === 2 ? 'Escalate only for P1 incidents or SLA breaches.' : null,
      });
      let userId: string | null = null;
      if (c.portal) {
        const [u] = await tx
          .insert(schema.users)
          .values({ email, name: c.name, phone: null, title: c.title, userType: 'customer', status: 'active', customerId: cust.id, timezone: seed.timezone, passwordHash, passwordChangedAt: state.now, lastLoginAt: new Date(state.now.getTime() - rng.int(2, 240) * 3_600_000) })
          .returning({ id: schema.users.id });
        userId = u!.id;
        await tx.insert(schema.userRoles).values({ userId, roleId: refs.role(c.portal), customerId: cust.id, createdBy: state.admin.id });
        await tx.update(schema.contacts).set({ userId }).where(eq(schema.contacts.id, row.id));
        cust.portalUsers.push({ id: userId, name: c.name, email, roleKey: c.portal, contactId: row.id });
      }
      cust.contacts.push({ id: row.id, name: c.name, email, title: c.title, isPrimary: !!c.isPrimary, escalationLevel: c.escalationLevel ?? null, userId });
    }
    await tx.insert(schema.customerTeams).values(seed.teamKeys.map((t) => ({ customerId: cust.id, teamId: refs.team(t) }))).onConflictDoNothing();
    state.customers.push(cust);
  }
  // Explicit customer visibility for field engineers (engineer role has no tenant:all) and the account manager.
  const grants: { userId: string; customerId: string }[] = [];
  for (const c of state.customers) {
    for (const k of c.fieldEngineerKeys) grants.push({ userId: state.users.get(k)!.id, customerId: c.id });
    grants.push({ userId: am.id, customerId: c.id });
  }
  await tx.insert(schema.userCustomerAccess).values(grants).onConflictDoNothing();
  state.counts.customers = state.customers.length;
  state.counts.sites = state.customers.reduce((s, c) => s + c.sites.length, 0);
  state.counts.contacts = state.customers.reduce((s, c) => s + c.contacts.length, 0);
  state.counts.portalUsers = state.customers.reduce((s, c) => s + c.portalUsers.length, 0);
}
