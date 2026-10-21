// Draft policy: local implementation only, not approval for live collection.
export const BUCKET_MS = 15 * 60_000;
export const STATES = ['creating', 'restoring', 'destroyed', 'destroying', 'started', 'stopped',
  'starting', 'stopping', 'error', 'build_failed', 'pending_build', 'building_snapshot',
  'unknown', 'pulling_snapshot', 'archived', 'archiving', 'resizing', 'snapshotting',
  'forking', 'pausing', 'paused', 'resuming'];
// Keep disjoint region/class series, rather than silently summing quotas or
// merging overlapping earth-region GPU samples. Unknown dimensions fail closed.
export const REGIONS = ['us', 'eu', 'earth'];
export const CLASSES = ['container', 'linux-vm', 'windows'];
export const DAYTONA_METRICS = Object.fromEntries(
  ['used_cpu', 'total_cpu', 'used_ram', 'total_ram', 'used_storage', 'total_storage', 'used_gpu', 'total_gpu']
    .map(suffix => [`daytona.sandbox.${suffix}`, { kind: 'gauge',
      unit: suffix.endsWith('cpu') ? 'cores' : suffix.endsWith('gpu') ? '1' : 'GiBy',
      attributes: ['region', 'sandbox_class'], fractional: true, source: 'daytona' }]));
