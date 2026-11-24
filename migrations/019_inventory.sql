-- What the business owns: game stations (console, controller, accounts), games, other gear and
-- subscriptions.
-- Passwords do not belong here; they stay in a password manager.
CREATE TABLE inventory_items (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('station', 'game', 'other', 'subscription')),
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  status TEXT NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use', 'spare', 'broken', 'gone')),
  price_cents INTEGER CHECK (price_cents >= 0),
  -- Fields that differ per kind: serial numbers and account names of a station, where a game comes from.
  details JSONB NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  -- When a subscription (or a station's Game Pass) runs out. The owner gets a notice 14 and 3
  -- days ahead; expiry_notice remembers which of those went out.
  expires_on DATE,
  expiry_notice SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inventory_items_kind ON inventory_items (kind, name);

-- Which gear went to which party, so it is known afterwards where each station has been.
CREATE TABLE booking_inventory (
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  item_id BIGINT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  PRIMARY KEY (booking_id, item_id)
);
CREATE INDEX booking_inventory_item ON booking_inventory (item_id);
