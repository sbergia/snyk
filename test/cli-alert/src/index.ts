import { Octokit } from '@octokit/rest';
import { IncomingWebhook } from '@slack/webhook';
import { IncomingWebhookDefaultArguments } from '@slack/webhook';

if (!process.env.USER_GITHUB_TOKEN || !process.env.SLACK_WEBHOOK_URL) {
  console.error('Missing USER_GITHUB_TOKEN or SLACK_WEBHOOK_URL');
  process.exit(1);
}

const GITHUB_TOKEN = process.env.USER_GITHUB_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

const octokitInstance = new Octokit({
  auth: GITHUB_TOKEN,
});
const slackWebhook = new IncomingWebhook(SLACK_WEBHOOK_URL);

async function run(octokit: Octokit) {
  try {
    // Get ID of smoke tests workflow
    const allWorkflows = (
      await octokit.actions.listRepoWorkflows({
        owner: 'snyk',
        repo: 'snyk',
      })
    ).data;

    let smokeTestsID = 0;
    for (const workflow of allWorkflows.workflows) {
      if (workflow.name === 'Smoke Tests') {
        smokeTestsID = workflow.id;
      }
    }

    // Get last 3 smoke tests workflows
    const workflows = (
      await octokit.actions.listWorkflowRuns({
        owner: 'snyk',
        repo: 'snyk',
        branch: 'master',
        // eslint-disable-next-line @typescript-eslint/camelcase
        workflow_id: smokeTestsID,
        // eslint-disable-next-line @typescript-eslint/camelcase
        per_page: 10,
      })
    ).data;
    console.log('Got latest smoke tests...');

    let failed = 0;
    let runID;

    // Check status of the last 10 smoke tests
    console.log('Checking status of smoke tests...');
    for (const workflow of workflows.workflow_runs) {
      if (workflow.conclusion === 'failure') {
        runID = workflow.id;
        failed += 1;
      }
    }

    // Check for failed smoke tests
    if (failed < 3) {
      console.log(
        'Less than 3 of the latest smoke tests failed. No need to alert.',
      );
      return;
    }

    // At least 3 of the recent smoke tests failed - re-run!
    console.log(
      'At least 3 of the latest smoke tests failed. Trying to re-run...',
    );
    await octokit.actions.reRunWorkflow({
      owner: 'snyk',
      repo: 'snyk',
      // eslint-disable-next-line @typescript-eslint/camelcase
      run_id: runID,
    });

    // Wait for run to finish
    let status = 'queued';
    let conclusion = '';
    const before = Date.now();
    console.log('Re-run in progress...');
    while (status !== 'completed') {
      const workflow = (
        await octokit.actions.getWorkflowRun({
          owner: 'snyk',
          repo: 'snyk',
          // eslint-disable-next-line @typescript-eslint/camelcase
          run_id: runID,
        })
      ).data;
      // Wait for 30 seconds
      await new Promise((r) => setTimeout(r, 30_000));
      status = workflow.status;
      conclusion = workflow.conclusion;
      const time = (Date.now() - before) / 1000;
      const minutes = Math.floor(time / 60);
      console.log(
        `Current status: "${status}". Elapsed: ${minutes} minute${
          minutes !== 1 ? 's' : ''
        }`,
      );
    }

    console.log('Re-run completed.');
    // If run failed again, send Slack alert
    if (conclusion === 'failure') {
      console.log('Smoke test failed again. Sending Slack alert...');
      const args: IncomingWebhookDefaultArguments = {
        username: 'Hammer Alerts',
        text:
          'Smoke Tests failed more than 3 times in a row. \n <https://github.com/snyk/snyk/actions?query=workflow%3A%22Smoke+Tests%22|Smoke Tests Results>',
        // eslint-disable-next-line @typescript-eslint/camelcase
        icon_emoji: 'hammer',
      };
      await slackWebhook.send(args);
      console.log('Slack alert sent.');
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

process.on('uncaughtException', (err) => {
  console.error(err);
  process.exit(1);
});

// Exec
run(octokitInstance);
