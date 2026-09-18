# How to Resume — Session-Start Protocol

Execute these steps **in order** at the start of every session, before any other
action. Do not skip steps.

## Step 1: Read `.claude/README.md`

Orient yourself: understand the project, stack, and structure.

## Step 2: Read `.claude/state/CURRENT_STATUS.md`

Know exactly what is done, in progress, and blocked.

## Step 3: Read `.claude/state/TASK_QUEUE.md`

Identify the next task and confirm its dependencies are met.

## Step 4: Read `.claude/AGENT_RULES.md`

Re-internalize all behavioral rules before touching anything.

## Step 5: Read `.claude/CODING_STANDARDS.md`

Re-internalize all conventions before writing any code.

## Step 6: Read `.claude/SECURITY_STANDARDS.md`

Re-internalize all security requirements before writing any code.

## Step 7: Identify the active environment

Check `APP_ENV` or equivalent — consult `ENVIRONMENT_GUIDE.md` if needed.
Never run commands until you know which environment you are in.

## Step 8: Read task-relevant docs

PRD section, architecture doc, API contract, or any doc directly relevant to
the current task. Read narrowly — only what the task requires.

## Step 9: Verify the environment is functional

Run the project's health-check or startup command.
(Update this step with the real command once it is known.)

## Step 10: Confirm no regressions

Run the existing test suite before writing any new code.
(Update this step with the real test command once it is known.)

## Step 11: Begin the task

Implement → test → security review → report → update all `.claude/` state files
(`CURRENT_STATUS.md`, `TASK_QUEUE.md`, `DECISIONS_LOG.md`, plus any standards
files whose content changed this session).
