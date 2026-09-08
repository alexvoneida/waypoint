-- Phase 4 slice 3: OSM-derived trail names. `name_source` records where a
-- trail's current name came from, so the trail-name job knows never to
-- overwrite an author's own correction, and so a later rename control can
-- offer OSM's runner-up candidates instead of an open text field.
alter table trails
  add column name_source text not null default 'activity'
    constraint trails_name_source_check check (name_source in ('activity', 'osm', 'user')),
  add column name_confidence real,
  add column name_candidates jsonb;

comment on column trails.name_source is
  'Where trails.name came from: activity (seeded at founding, the default), osm (an accepted OSM suggestion), or user (an author correction, which nothing may overwrite).';
comment on column trails.name_confidence is
  'The winning OSM candidate''s final score (geometric coverage plus text boost) when name_source = osm; null otherwise.';
comment on column trails.name_candidates is
  'Ranked OSM candidates considered for this trail''s name (winner and runners-up), each {name, coverage, textBoost, score}, for a rename control to offer instead of free text.';
