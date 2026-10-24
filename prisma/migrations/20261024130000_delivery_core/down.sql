-- Reverses 20261024130000_delivery_core. The PostGIS extension stays: other schemas may use it.
DROP TABLE "delivery"."delivery_events";
DROP TABLE "delivery"."deliveries";
DROP SCHEMA "delivery";
