# CloudFuze Migration Status Enums

CloudFuze has **no single unified status enum** — each entity/queue/scheduler
defines its own, though most share a common vocabulary:

`NOT_PROCESSED / NOT_STARTED / YET_TO_STARTED` → `IN_PROGRESS / PROCESSING` →
`PROCESSED / COMPLETE / COMPLETED / SUCCESS`, plus `CONFLICT`, `CANCEL`,
`PAUSE`, `SUSPENDED`, `ERROR`, `WARNING`, `RETRYING`, `TIMED_OUT`, `NO_MESSAGE`.

Canonical buckets the assistant maps every value to: **processed, in-progress,
not-processed, conflict, failed, retry, paused, cancelled, warning, empty.**

## 1. Scheduler / job lifecycle (cron-level, not migration content)
- **CFScheduler.SCHEDULER_STATUS** — STARTED, NOT_STARTED, IN_PROGRESS, CANCELLED, PENDING, NONE, ACTIVE, INACTIVE
- **CFJob.JOB_STATUS** — SUCCESS, FAIL, IN_PROGRESS, CANCELLED, PENDING, WARNING
- **CFJobHistory.JOB_STATUS** — SUCCESS, FAIL
- **DeltaMigrationScheduler.SCHEDULER_STATUS** — STARTED, NOT_STARTED, IN_PROGRESS, CANCELLED, PENDING, NONE, ACTIVE, INACTIVE, RESUME, STOP, PAUSE
- **SyncMigrationScheduler.C_SCHEDULER_STATUS** — the above + TRIAL_PAUSE

## 2. Core file-migration workspace — `CFMoveWorkSpace` (most reused, ~30 schedulers)
- **STATUS**: YET_TO_STARTED, PROCESSING, COMPLETE, ERROR, REPORT_DOWNLOAD, REPORT_NOTPROCESSED, SUSPENDED, CONFLICT
- **PROCESS**: NOT_PROCESSED, IN_PROGRESS, PROCESSED, CANCEL, CONFLICT, PAUSE, IN_QUEUE, WARNING, SUSPENDED, plus combined `PROCESSED_WITH_SOME_*` variants
- Also REPORT_STATUS, LOADLOCK_STATUS (STARTED, COMPLETED), COLL_DETAILS
- **CFMoveWorkSpaceStatus.LOADLOCK_STATUS** (STARTED, COMPLETED, NO_REPORT) and **.MIGRATION_STATUS** (IN_PROGRESS, CANCEL)

## 3. Per-file processing — `CFMove_EachFile.PROCESS` (2nd most reused)
NOT_PROCESSED, NOT_STARTED, IN_PROGRESS, PROCESSED, CANCEL, CONFLICT, PAUSE, WARNING, IN_QUEUE, SUSPENDED, RETRYING, ERROR, plus `VERSION_*` and `PATH_*` variants.

## 4. Multi-user / queue — `MultiUserMoveQueue.MULTIUSER_STATUS` (3rd most reused)
NOT_PROCESSED, IN_PROGRESS, PROCESSED, TIMED_OUT, PAUSE, CANCEL, RESUME, SUSPENDED, PREMIGRATION.
Plus JOB_TYPE_STATUS (ONETIME/DELTA/SYNC), USER_TYPE (ACTIVE/INACTIVE/MULTIUSER_*).
Related: MultiUserMoveJob.JOB_STATUS, ConsumerMoveJob.C_JOB_STATUS, ConsumerMoveQueue.CONSUMER_STATUS.

## 5. Message / chat migration (Slack / Teams / DMs / Channels)
- **CFMessageEachFiles.MESSAGE_STATUS** (ChannelMessageMigrationScheduler, DirectMessageMigrationScheduler/V2, DmsMessageMigrationScheduler…): NOT_PROCESSED, IN_PROGRESS, PROCESSED, CANCEL, CONFLICT, PAUSE, WARNING, IN_QUEUE, SUSPENDED, RETRYING, ERROR, plus `REPLIES_*` / `REACTION_*` / `VERSION_*` variants
- **MessageMoveQueue.MESSAGE_STATUS**: adds PICKING_IN_PROGRESS, PICKING_NOT_PROCESSED
- **SlackDms.STATUS**: same base + NO_MESSAGE
- **MessageWorkSpaceTransferStatus / DMMsgWorkSpaceTransferStatus**: STARTED, IN_PROGRESS, COMPLETED, CANCEL, CONFLICT, PAUSE, RESUME, RETRYING
- **CFMessageJob.MESSAGEJOB_STATUS**: adds MULTIUSERTRAIL_COMPLETED, PARTIALLY_COMPLETED, DELTA_IN_PROGRESS/COMPLETED, SPACE_NOT_CLOSED, RESUME; **.TEAM_STATUS**: CLOSE/OPEN

## 6. Permission / collaboration
CFPermissionSharing.SHARING_STATUS, CollabarationDetails.PERMISSION_STATUS, ClosingAndSharing.SHARING_STATUS / CLOSING_STATUS (adds CLOUD_DELETED, NOT_REQUIRED, INVITE_MEMBER, INVITE_CONFLICT), PermissionReport.PROCESS.

## 7. Metadata / delta-change
MetadataInfo.METADATA_PROCESS, ChangesMetaDataInfo.PROCESS, DeltaChangesMetaDataInfo.PROCESS, DriveChangeIdDetails.CHANGE_STATUS.

## 8. Links / paths
CFHyperLinks.PROCESS, CFPathLinks.PROCESS, PathLinksQueue.PROCESS (adds PICKING_DONE, RESTART, TIMED_OUT).

## 9. Pre-scan / pre-migration
CFPreScanWorkSpace.PROCESS, PremigrationReport.PROCESS, MessageReport.PROCESS / MessageReportWS.PROCESS, CFBoardsPremigration.PREMIGRATION_BOARD_STATUS, CFBoardWorkspace.MIGRATION_PROCESS.

## 10. Account / billing (peripheral)
CFCloud.STATUS (ACTIVE/INACTIVE/INVITED), CFUserSubscription.STATUS, CFPayment.PAYMENT_STATUS (PAID/PENDING/OTHER/CANCELLED/EXPIRED).

## What the common values mean
- **PROCESSED / COMPLETE / COMPLETED / SUCCESS** — migrated successfully.
- **PROCESSED_WITH_SOME_CONFLICTS** — completed, but some items conflicted.
- **NOT_PROCESSED / NOT_STARTED / YET_TO_STARTED / IN_QUEUE / PICKING_NOT_PROCESSED / PREMIGRATION** — not migrated yet (queued/pending).
- **IN_PROGRESS / PROCESSING / PICKING_IN_PROGRESS / DELTA_IN_PROGRESS** — currently migrating.
- **CONFLICT / INVITE_CONFLICT / REPLIES_CONFLICT** — blocked by an existing item or mapping conflict; needs resolution.
- **ERROR / FAIL / TIMED_OUT** — errored during migration.
- **RETRYING** — will be retried automatically.
- **PAUSE / SUSPENDED / STOP / TRIAL_PAUSE** — halted; resumes on RESUME.
- **CANCEL / CANCELLED** — cancelled; will not complete on its own.
- **WARNING** — completed with a non-fatal warning.
- **NO_MESSAGE** — the source channel/workspace was empty; nothing to migrate (not a failure).

> Note: a few `*Status` classes (InstanceStatus, MailStatus, ProvisionStatus,
> UserStatus) are not enums — they hold raw String status fields.
