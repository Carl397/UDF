/**
 * Party content served by the public API so the app, the website and printed
 * material all quote the same wording. Editable here (or later, in a CMS).
 */

export const PARTY_PROFILE = {
  name: 'UDF',
  fullName: 'United Democratic Front',
  tagline: 'One flag · One movement',
  slogan: 'Service before self',
  colors: { red: '#E0271E', black: '#141414', gold: '#F7C31D' },
  contacts: {
    email: 'info@udf-party.co.za',
    press: 'info@udf-party.co.za',
    website: 'https://www.udf-party.co.za',
    address: 'UDF National Secretariat',
  },
  officeHours: 'Mon to Fri 08:00 to 17:00 · Sat 09:00 to 13:00',
  joinUrl: '/register',
} as const;

export const MANIFESTO = {
  mission:
    'To organise ordinary people in every ward so that public power is used to deliver ' +
    'dignified services, honest work and safe neighbourhoods. We hold every ' +
    'representative answerable to the branch that elected them.',
  vision:
    'A country where the queue at the clinic is short, the tap runs, the classroom has a ' +
    'teacher, and any citizen can reach their representative in one phone call.',
  values: [
    {
      name: 'Service before self',
      text: 'Office is a duty, not a prize. Every mandate carries a service commitment.',
    },
    {
      name: 'Truth in public',
      text: 'We publish what we know, correct what we got wrong, and never hide behind silence.',
    },
    {
      name: 'Ward first',
      text: 'Decisions belong to the branch closest to the problem; the centre coordinates.',
    },
    {
      name: 'Non-violence & discipline',
      text: 'We protest, petition and vote — we do not intimidate, and we do not vandalise.',
    },
    {
      name: 'Clean hands',
      text: 'No member may hold office while under an unresolved finding of corruption.',
    },
  ],
  pillars: [
    {
      title: 'Service delivery',
      points: [
        'Water, power and sanitation restored within published response times',
        'A community note logged and tracked for every reported fault',
        'Quarterly service-delivery scorecards per ward',
      ],
    },
    {
      title: 'Work & local economy',
      points: [
        'Public-works contracts awarded to ward-based cooperatives',
        'Youth apprenticeships tied to municipal maintenance budgets',
        'Informal traders protected from arbitrary eviction',
      ],
    },
    {
      title: 'Safety & justice',
      points: [
        'Community policing forums with published meeting minutes',
        'Lighting and safe routes audited twice a year per ward',
        'Legal aid desks for evictions, gender-based violence and labour disputes',
      ],
    },
    {
      title: 'Health & education',
      points: [
        'Clinic staffing and medicine stock reported monthly',
        'School infrastructure backlog cleared on a published schedule',
        'Nutrition programmes funded before discretionary spending',
      ],
    },
    {
      title: 'Honest government',
      points: [
        'Open tender registers and beneficial-ownership disclosure',
        'Recall mechanism: a branch may revoke a mandate by two-thirds vote',
        'Public audit trail for every decision taken in the party name',
      ],
    },
  ],
  guide: {
    intro:
      'How the UDF is organised from the street upwards, and what is expected of every member.',
    structures: [
      { level: 'Branch', body: 'Street / block members', role: 'Elects ward chair, logs community notes, runs canvasses' },
      { level: 'Ward', body: 'Ward executive committee', role: 'Coordinates branches, nominates the ward candidate' },
      { level: 'District', body: 'District coordinating committee', role: 'Aggregates wards, manages training and observers' },
      { level: 'Region', body: 'Regional executive committee', role: 'Approves regional appointments, media and budgets' },
      { level: 'National', body: 'National executive & secretariat', role: 'Sets policy, issues press releases, audits the movement' },
    ],
    memberDuties: [
      'Keep your membership record and ward assignment current',
      'Attend at least one branch meeting per quarter',
      'Report service-delivery failures as community notes with evidence',
      'Campaign peacefully and refuse any inducement for a vote',
      'Protect member data — never share the membership list outside the party',
    ],
    mandateRules: [
      'An appointment is proposed by the relevant executive committee',
      'The appointee receives a mandate link and must accept it personally',
      'Accepted mandates are recorded in the tamper-evident audit log',
      'A mandate may be revoked by the appointing body or by branch recall',
    ],
  },
} as const;

/** Short "what we stand for" block used on the landing / press pages. */
export const STANDS_FOR = MANIFESTO.pillars.map((p) => p.title);

/**
 * Terms & Conditions for the mobile app and membership.
 *
 * Bump `TERMS_VERSION` whenever the wording changes materially: acceptance is
 * recorded per version, so a bump asks every member/app user to re-accept on
 * their next sign-in. The app compares a user's stored `tc_version` to this.
 */
export const TERMS_VERSION = '1.0.0';
export const TERMS_UPDATED_AT = '2025-01-15';

export const TERMS = {
  version: TERMS_VERSION,
  updatedAt: TERMS_UPDATED_AT,
  title: 'Terms & Conditions',
  intro:
    'These Terms govern your use of the UDF mobile app and your membership of the ' +
    'United Democratic Front. Please read them together with our privacy notice. ' +
    'By registering as a member, creating an account, or continuing to use the app, ' +
    'you accept these Terms.',
  sections: [
    {
      heading: '1. Your membership and account',
      body:
        'Membership is open to every resident who supports the UDF programme. You must ' +
        'give accurate information, keep your ward assignment current, and confirm your ' +
        'contact details when asked. App accounts are personal: do not share your ' +
        'password, and sign out on any device that is not yours.',
    },
    {
      heading: '2. Acceptable use',
      body:
        'Use the app lawfully and respectfully. You must not: intimidate, harass, ' +
        'hate-speech or defame any person; incite violence or vandalism; upload false, ' +
        'misleading or unlawful content; impersonate another member or official; spam or ' +
        'bulk-message people without consent; attempt to access data that is not yours; ' +
        'or interfere with the security or operation of the platform.',
    },
    {
      heading: '3. Contacting your ward councillor',
      body:
        'The "Report to my councillor" feature routes your message, and any photo, audio, ' +
        'video or location you attach, to the councillor for your ward so they can act on ' +
        'it. Only submit content you are entitled to share. Reports are visible to you and ' +
        'to the staff responsible for your ward, and are recorded in our audit log.',
    },
    {
      heading: '4. Your privacy (POPIA)',
      body:
        'We process only the personal information needed to run the movement and deliver ' +
        'services to your ward. Contact details are stored encrypted; your supporter ' +
        'portrait is composed on your own device and is not uploaded unless you choose to ' +
        'save it. We never sell member data. You may request access to, correction of, or ' +
        'deletion of your information at any time.',
    },
    {
      heading: '5. Moderation, suspension and bans',
      body:
        'If you breach these Terms we may, depending on the severity: issue a warning; ' +
        'suspend your account for a stated period; or ban your account. A ban or ' +
        'suspension takes effect immediately and signs you out on all devices. We may also ' +
        'block a specific device from signing in or registering. Every moderation decision ' +
        'records a reason and the responsible official, and can be reviewed on appeal.',
    },
    {
      heading: '6. Device security',
      body:
        'For your protection the app blocks screenshots and screen recording and may ' +
        'request permission to use your camera, microphone and location. These are used ' +
        'only for the features you invoke. A blocked device cannot be used to sign in or ' +
        'register, even with valid credentials.',
    },
    {
      heading: '7. Changes to these Terms',
      body:
        'We may update these Terms from time to time. When we do, the version and date ' +
        'below change and we will ask you to accept the new Terms before you continue to ' +
        'use the app.',
    },
    {
      heading: '8. Contact',
      body:
        'Questions about these Terms, an appeal against a moderation decision, or a ' +
        'privacy request can be sent to the National Secretariat at the contact details ' +
        'published in the app.',
    },
  ],
  acceptance:
    'I have read and accept the UDF Terms & Conditions and the privacy notice.',
} as const;
