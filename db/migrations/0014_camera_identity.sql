-- P-5: camera identity, corrected for the common case of a serial-less body.
--
-- 0002's `unique (user_id, make, model, body_serial)` was written assuming
-- body_serial would usually be present, but EXIF's BodySerialNumber tag is
-- frequently absent -- plenty of bodies never populate it, and stripped
-- exports drop it along with everything else optional. In SQL, two NULLs are
-- never equal, so a plain unique constraint does not consider two
-- (user_id, make, model, NULL) rows a conflict at all: every upload from a
-- serial-less body would insert a fresh camera_profiles row instead of
-- reusing the one from last time, defeating the whole point of a profile
-- that accumulates a calibrated offset across uploads.
--
-- coalesce(body_serial, '') maps every "no serial reported" row for a given
-- user/make/model onto the same identity, so it is the fix: it treats
-- "unknown serial" as one shared identity per user/make/model rather than as
-- a family of never-equal unknowns. The cost -- two distinct bodies of the
-- same make and model, neither reporting a serial, get collapsed onto one
-- profile -- is accepted for V1: it is the same ambiguity a photographer
-- would have trying to tell the bodies apart by EXIF alone.
create unique index camera_profiles_identity
  on camera_profiles (user_id, make, model, coalesce(body_serial, ''));

-- The original constraint is now redundant, not merely superseded: every
-- pair of rows it would reject also collides on the new index (when
-- body_serial is non-null, coalesce(body_serial, '') is just body_serial),
-- and it additionally misses the null-serial case the new index exists to
-- catch. Nothing depends on it being a *constraint* specifically (no other
-- migration references it by name, and camera_profiles has no foreign key
-- pointed at this tuple), so it is dropped rather than left beside a strictly
-- stronger index doing the same job.
alter table camera_profiles
  drop constraint camera_profiles_user_id_make_model_body_serial_key;
