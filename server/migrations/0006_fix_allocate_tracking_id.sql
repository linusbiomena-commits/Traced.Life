-- Fix for 0005: in allocate_tracking_id the OUT parameter "period" clashed with the
-- tracking_sequences.period column inside the upsert ("column reference is ambiguous").
-- Same behaviour; the conflict is resolved by preferring table columns inside the function.
-- (0005 is left untouched because migrations are checksummed once applied.)

CREATE OR REPLACE FUNCTION allocate_tracking_id(at timestamptz DEFAULT now(),
                                                OUT period char(4), OUT seq integer, OUT tracking_id text)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  p char(4) := to_char(at AT TIME ZONE 'Asia/Riyadh', 'YYMM');
  n integer;
BEGIN
  BEGIN
    INSERT INTO tracking_sequences AS t (period, last_value) VALUES (p, 1)
    ON CONFLICT (period) DO UPDATE SET last_value = t.last_value + 1, updated_at = now()
    RETURNING t.last_value INTO n;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'TRACKING_SEQUENCE_EXHAUSTED: monthly limit of 99999 reached for %', p USING ERRCODE = 'TRX01';
  END;
  allocate_tracking_id.period := p;
  allocate_tracking_id.seq := n;
  allocate_tracking_id.tracking_id := 'TRC-SA-' || substr(p, 3, 2) || '/' || substr(p, 1, 2) || '-' || lpad(n::text, 5, '0');
END;
$$;
