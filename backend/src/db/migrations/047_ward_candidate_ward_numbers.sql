-- Ward councillor roster: replace the generic "NN wards" counts with each
-- candidate's ACTUAL City of Cape Town ward numbers, shown as compact ranges.
--
-- Source: the IEC LGE2026 Western Cape certified candidate list, decoded to the
-- 118 CPT wards (8-digit order number - 19100000 = local ward). 116 ward slots
-- are held by 25 candidates; wards 61 and 66 have no UDF candidate. Label
-- format: a run of 3+ consecutive wards is "a–b" (en-dash), a pair is "a, b", a
-- lone ward is "Ward n". MICHAEL JACK POGGENPOEL (party-list #13) is list-only
-- with no ward slots, so his "Regional list" label is intentionally untouched.
--
-- Idempotent: every UPDATE targets a fixed seed id from 045_ward_candidates.sql.
-- Fits the existing wards_label CHECK (<= 160); the longest label is 101 chars.
  UPDATE ward_candidates SET wards_label = 'Wards 2, 3, 5–13, 15–19, 23, 31, 33, 35, 39–41, 50, 52, 54, 55, 59, 91, 93–97, 99, 101, 103, 117, 118', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000001'; -- ANDHOR GREY MARKS (39)
  UPDATE ward_candidates SET wards_label = 'Wards 26–28, 30, 34, 36–38, 42, 44, 51', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000002'; -- ANDHOR KARL MARKS (11)
  UPDATE ward_candidates SET wards_label = 'Wards 43, 87–89, 102, 104–106, 108, 109', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000003'; -- MARK MINNIES (10)
  UPDATE ward_candidates SET wards_label = 'Wards 20–22, 24, 25, 53, 56–58, 62, 63, 73, 85, 98, 100, 112–114', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000004'; -- JOSEPH RICHARD NICHOLS NEFDT (18)
  UPDATE ward_candidates SET wards_label = 'Wards 71, 74, 77, 80, 83, 84, 86, 90, 92, 107, 111, 115', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000005'; -- ROY STANLEY PRINSLOO (12)
  UPDATE ward_candidates SET wards_label = 'Wards 46–49', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000006'; -- FATIMA SWARTZ (4)
  UPDATE ward_candidates SET wards_label = 'Wards 69, 70', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000007'; -- ASHLEY CRAIG CLOETE (2)
  UPDATE ward_candidates SET wards_label = 'Ward 72', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000008'; -- ROGER STEVE ROMAN (1)
  UPDATE ward_candidates SET wards_label = 'Ward 78', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000009'; -- RASHIED SOLOMONS (1)
  UPDATE ward_candidates SET wards_label = 'Ward 45', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000010'; -- RAYBIN THOMAS CHARLES WINDVOGEL (1)
  UPDATE ward_candidates SET wards_label = 'Ward 67', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000011'; -- RONALD STEPHEN SIMONS (1)
  UPDATE ward_candidates SET wards_label = 'Ward 82', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000012'; -- LIONEL GODFREY SOLOMONS (1)
  UPDATE ward_candidates SET wards_label = 'Wards 29, 32', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000014'; -- MAHMOUD ESTERHUIZEN (2)
  UPDATE ward_candidates SET wards_label = 'Ward 116', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000015'; -- JEFF MARIO THOMAS CHRISTIANS (1)
  UPDATE ward_candidates SET wards_label = 'Ward 76', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000016'; -- TREVOR LESLEY ISAAC JANTJES (1)
  UPDATE ward_candidates SET wards_label = 'Wards 1, 4', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000017'; -- SEAN FREDERICK NEFDT (2)
  UPDATE ward_candidates SET wards_label = 'Ward 110', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000018'; -- AUBREY CHARLES ROBINSON (1)
  UPDATE ward_candidates SET wards_label = 'Ward 75', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000019'; -- KENNITH PHILIP HOFFMAN (1)
  UPDATE ward_candidates SET wards_label = 'Ward 60', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000020'; -- ANDRE CHRISTOPHER SAMPIE (1)
  UPDATE ward_candidates SET wards_label = 'Ward 65', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000021'; -- DENVER DANIELS (1)
  UPDATE ward_candidates SET wards_label = 'Ward 14', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000022'; -- JEFFREY BOTHATA OLIPHANT (1)
  UPDATE ward_candidates SET wards_label = 'Ward 81', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000023'; -- STEPHEN NOBLE (1)
  UPDATE ward_candidates SET wards_label = 'Ward 79', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000024'; -- CHRISTOPHER VAN DER VENT (1)
  UPDATE ward_candidates SET wards_label = 'Ward 68', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000025'; -- KAREN DAWN MAARMAN (1)
  UPDATE ward_candidates SET wards_label = 'Ward 64', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000026'; -- JACQUELINE WEAVER MARKS (1)
