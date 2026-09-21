-- Ward candidates ("Meet our ward councillors"): a database-backed roster that
-- non-devs manage from the CRM (/crm/candidates), surfaced on the public site.
--
-- Seeded from the IEC LGE2026 Western Cape certified candidate list (the 26
-- distinct UNITED DEMOCRATIC FRONT PARTY candidates for City of Cape Town).
-- Names, party-list order and ward-slot counts come from that extract; bios and
-- photos start empty for the party to fill in through the CRM. Fixed ids keep
-- the seed idempotent and make teardown deterministic.
CREATE TABLE IF NOT EXISTS ward_candidates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name      text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 160),
  role_label     text NOT NULL DEFAULT ''  CHECK (char_length(role_label)  <= 120),
  wards_label    text NOT NULL DEFAULT ''  CHECK (char_length(wards_label) <= 160),
  bio            text NOT NULL DEFAULT ''  CHECK (char_length(bio)         <= 2000),
  photo_media_id uuid REFERENCES media_assets (id) ON DELETE SET NULL,
  sort_order     integer NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT TRUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ward_candidates_active_idx
  ON ward_candidates (is_active, sort_order);

INSERT INTO ward_candidates (id, full_name, role_label, wards_label, sort_order)
VALUES
  ('c0000000-0000-4000-8000-000000000001', 'ANDHOR GREY MARKS',                'Party list #1',  '39 wards', 1),
  ('c0000000-0000-4000-8000-000000000002', 'ANDHOR KARL MARKS',                'Party list #2',  '11 wards', 2),
  ('c0000000-0000-4000-8000-000000000003', 'MARK MINNIES',                     'Party list #3',  '10 wards', 3),
  ('c0000000-0000-4000-8000-000000000004', 'JOSEPH RICHARD NICHOLS NEFDT',     'Party list #4',  '18 wards', 4),
  ('c0000000-0000-4000-8000-000000000005', 'ROY STANLEY PRINSLOO',             'Party list #5',  '12 wards', 5),
  ('c0000000-0000-4000-8000-000000000006', 'FATIMA SWARTZ',                    'Party list #6',  '4 wards',  6),
  ('c0000000-0000-4000-8000-000000000007', 'ASHLEY CRAIG CLOETE',              'Party list #7',  '2 wards',  7),
  ('c0000000-0000-4000-8000-000000000008', 'ROGER STEVE ROMAN',                'Party list #8',  '1 ward',   8),
  ('c0000000-0000-4000-8000-000000000009', 'RASHIED SOLOMONS',                 'Party list #9',  '1 ward',   9),
  ('c0000000-0000-4000-8000-000000000010', 'RAYBIN THOMAS CHARLES WINDVOGEL',  'Party list #10', '1 ward',  10),
  ('c0000000-0000-4000-8000-000000000011', 'RONALD STEPHEN SIMONS',            'Party list #11', '1 ward',  11),
  ('c0000000-0000-4000-8000-000000000012', 'LIONEL GODFREY SOLOMONS',          'Party list #12', '1 ward',  12),
  ('c0000000-0000-4000-8000-000000000013', 'MICHAEL JACK POGGENPOEL',          'Party list #13', 'Regional list', 13),
  ('c0000000-0000-4000-8000-000000000014', 'MAHMOUD ESTERHUIZEN',              'Party list #14', '2 wards', 14),
  ('c0000000-0000-4000-8000-000000000015', 'JEFF MARIO THOMAS CHRISTIANS',     'Party list #15', '1 ward',  15),
  ('c0000000-0000-4000-8000-000000000016', 'TREVOR LESLEY ISAAC JANTJES',      'Party list #16', '1 ward',  16),
  ('c0000000-0000-4000-8000-000000000017', 'SEAN FREDERICK NEFDT',             'Party list #17', '2 wards', 17),
  ('c0000000-0000-4000-8000-000000000018', 'AUBREY CHARLES ROBINSON',          'Party list #18', '1 ward',  18),
  ('c0000000-0000-4000-8000-000000000019', 'KENNITH PHILIP HOFFMAN',           'Party list #19', '1 ward',  19),
  ('c0000000-0000-4000-8000-000000000020', 'ANDRE CHRISTOPHER SAMPIE',         'Party list #20', '1 ward',  20),
  ('c0000000-0000-4000-8000-000000000021', 'DENVER DANIELS',                   'Party list #21', '1 ward',  21),
  ('c0000000-0000-4000-8000-000000000022', 'JEFFREY BOTHATA OLIPHANT',         'Party list #22', '1 ward',  22),
  ('c0000000-0000-4000-8000-000000000023', 'STEPHEN NOBLE',                    'Party list #23', '1 ward',  23),
  ('c0000000-0000-4000-8000-000000000024', 'CHRISTOPHER VAN DER VENT',         'Party list #24', '1 ward',  24),
  ('c0000000-0000-4000-8000-000000000025', 'KAREN DAWN MAARMAN',               'Party list #25', '1 ward',  25),
  ('c0000000-0000-4000-8000-000000000026', 'JACQUELINE WEAVER MARKS',          'UDF candidate',  '1 ward',  26)
ON CONFLICT (id) DO NOTHING;
