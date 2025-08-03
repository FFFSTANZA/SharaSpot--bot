const {
  pgTable,
  serial,
  text,
  real,
  boolean,
  integer,
  jsonb,
  timestamp,
  pgEnum
} = require('drizzle-orm/pg-core');

const { nanoid } = require('nanoid');
const generateId = () => nanoid();

// 🔹 Enums
const vehicleEnum = pgEnum('vehicle_type', [
  'Two-wheeler',
  '4-seat car',
  '8-seat car',
  'Van'
]);

const bookingStatusEnum = pgEnum('status', [
  'pending',
  'confirmed',
  'cancelled',
  'expired'
]);

const slotStateEnum = pgEnum('slot_state', [
  'available',
  'occupied',
  'maintenance',
  'blocked'
]);

// 🔹 Common Timestamps
const commonTimestamps = {
  created_at: timestamp('created_at').$defaultFn(() => new Date()),
  updated_at: timestamp('updated_at').$defaultFn(() => new Date())
};

// 🔹 Users Table
const users = pgTable('users', {
  id: text('id').primaryKey().$defaultFn(generateId),
  number: text('number').notNull().unique(),
  prev_msg: jsonb('prev_msg').default([]),
  ai_msg: jsonb('ai_msg').default([]),
  is_admin: boolean('is_admin').default(false),
  current_mode: text('current_mode').default('AI'),
  booking_data: jsonb('booking_data').default(null),
  last_interaction: timestamp('last_interaction').$defaultFn(() => new Date()),
  created_at: timestamp('created_at').$defaultFn(() => new Date())
});

// 🔹 Owners Table (with userId with snake_case columns)
const owners = pgTable('owners', {
  id: text('id').primaryKey().$defaultFn(generateId),
  user_id: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  phone_num: text('phone_num').notNull().unique(),
  name: text('name').notNull().default(''),
  lat: real('lat').notNull().default(0),
  lon: real('lon').notNull().default(0),
  is_active: boolean('is_active').notNull().default(false),
  total_slots: integer('total_slots').default(0),
  location: text('location').notNull().default('Unknown'),
  last_updated: timestamp('last_updated').$defaultFn(() => new Date()),
  ...commonTimestamps
});

// 🔹 AvailableVehicleTypes (Many-to-Many)
const ownerVehicleTypes = pgTable('owner_vehicle_types', {
  id: serial('id').primaryKey(),
  owner_id: text('owner_id').notNull().references(() => owners.id, { onDelete: 'cascade' }),
  vehicle_type: vehicleEnum('vehicle_type').notNull()
});

// 🔹 Slots Table
const slots = pgTable('slots', {
  id: text('id').primaryKey().$defaultFn(generateId),
  owner_id: text('owner_id')
    .notNull()
    .references(() => owners.id, { onDelete: 'cascade' }),
  index: integer('index').notNull(),
  type: vehicleEnum('type').notNull(),

  state: slotStateEnum('state').notNull().default('available'),
  is_occupied: boolean('is_occupied').notNull().default(false),
  connected_to: text('connected_to'),
  notes: text('notes').default(''),
  last_status_change: timestamp('last_status_change').$defaultFn(() => new Date()),

  ...commonTimestamps
});

// 🔹 Predefined Locations Table
const predefinedLocations = pgTable('predefined_locations', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  latitude: real('latitude').notNull(),
  longitude: real('longitude').notNull(),
  ...commonTimestamps
});

// 🔹 Bookings Table
const bookings = pgTable('bookings', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => `TKT-${generateId().substring(0, 8).toUpperCase()}`),
  user_id: text('user_id').notNull().references(() => users.id),
  owner_id: text('owner_id').notNull().references(() => owners.id),
  slot_id: text('slot_id').references(() => slots.id),
  slot_number: integer('slot_number'),
  vehicle_type: vehicleEnum('vehicle_type').notNull(),
  destination: text('destination'),
  destination_lat: real('destination_lat'),
  destination_lon: real('destination_lon'),
  status: bookingStatusEnum('status').default('pending'),
  created_at: timestamp('created_at').$defaultFn(() => new Date()),
  expires_at: timestamp('expires_at')
});


module.exports = {
  owners,
  users,
  predefinedLocations,
  bookings,
  slots,
  ownerVehicleTypes,
  vehicleEnum,
  bookingStatusEnum,
  slotStateEnum
};







