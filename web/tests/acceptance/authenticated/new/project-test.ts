import RouterService from "@ember/routing/router-service";
import { click, fillIn, visit, waitFor } from "@ember/test-helpers";
import { MirageTestContext, setupMirage } from "ember-cli-mirage/test-support";
import { setupApplicationTest } from "ember-qunit";
import { authenticateSession } from "ember-simple-auth/test-support";
import { Response } from "miragejs";
import { module, test } from "qunit";

const PROJECT_FORM = "[data-test-project-form]";
const HEADLINE = "[data-test-form-headline]";
const ICON = "[data-test-feature-icon]";
const TITLE_INPUT = `${PROJECT_FORM} [data-test-title]`;
const DESCRIPTION_INPUT = `${PROJECT_FORM} [data-test-description]`;
const SUBMIT_BUTTON = `${PROJECT_FORM} [data-test-submit]`;
const SECONDARY_CREATE_BUTTON = `${PROJECT_FORM} .hds-button--color-secondary`;
const PRIMARY_CREATE_BUTTON = `${PROJECT_FORM} .hds-button--color-primary`;
const TITLE_ERROR = `${PROJECT_FORM} [data-test-title-error]`;
const FLASH_MESSAGE = "[data-test-flash-notification]";
const TASK_IS_RUNNING_DESCRIPTION = "[data-test-task-is-running-description]";

interface AuthenticatedNewProjectRouteTestContext extends MirageTestContext {}

module("Acceptance | authenticated/new/project-form", function (hooks) {
  setupApplicationTest(hooks);
  setupMirage(hooks);

  hooks.beforeEach(async function (
    this: AuthenticatedNewProjectRouteTestContext,
  ) {
    await authenticateSession({});
  });

  test("the page title is correct", async function (this: AuthenticatedNewProjectRouteTestContext, assert) {
    await visit("/new/project");
    assert.equal(document.title, "Start a project | Hermes");
  });

  test("you can create a new project", async function (this: AuthenticatedNewProjectRouteTestContext, assert) {
    const title = "The Foo Project";
    const description = "A project about foo";

    await visit("new/project");

    await fillIn(TITLE_INPUT, title);
    await fillIn(DESCRIPTION_INPUT, description);

    await click(SUBMIT_BUTTON);

    // Confirm that the project was created

    const project = this.server.schema.projects.find(1);

    assert.equal(project.title, title);
    assert.equal(project.description, description);

    // Confirm we were routed to the project screen

    const routerService = this.owner.lookup("service:router") as RouterService;

    assert.equal(
      routerService.currentRouteName,
      "authenticated.projects.project",
    );

    assert.equal(routerService.currentURL, "/projects/1");

    assert.equal(document.title, `${title} | Hermes`);
  });

  test("it shows an error when the title is empty", async function (this: AuthenticatedNewProjectRouteTestContext, assert) {
    await visit("new/project");

    assert.dom(TITLE_ERROR).doesNotExist();

    await click(SUBMIT_BUTTON);

    assert.dom(TITLE_ERROR).hasText("Title is required.");
  });

  test("it shows a loading screen while a project is being created", async function (this: AuthenticatedNewProjectRouteTestContext, assert) {
    await visit("new/project");

    assert.dom(HEADLINE).hasText("Start a project");
    assert.dom(ICON).hasAttribute("data-test-icon", "grid");
    assert.dom(TASK_IS_RUNNING_DESCRIPTION).doesNotExist();

    await fillIn(TITLE_INPUT, "The Foo Project");

    const clickPromise = click(SUBMIT_BUTTON);

    await waitFor(TASK_IS_RUNNING_DESCRIPTION);

    assert.dom(HEADLINE).hasText("Creating project...");
    assert.dom(ICON).hasAttribute("data-test-icon", "running");
    assert
      .dom(TASK_IS_RUNNING_DESCRIPTION)
      .hasText("This shouldn't take long.");

    await clickPromise;
  });

  test("it shows an error if creating the project fails", async function (this: AuthenticatedNewProjectRouteTestContext, assert) {
    this.server.post("/projects", () => {
      return new Response(500, {}, {});
    });

    await visit("new/project");
    await fillIn(TITLE_INPUT, "The Foo Project");

    await click(SUBMIT_BUTTON);

    await waitFor(FLASH_MESSAGE);
    assert.dom(FLASH_MESSAGE).containsText("Error creating project");
  });

  test("the button changes color when the form is valid", async function (this: AuthenticatedNewProjectRouteTestContext, assert) {
    await visit("/new/project");

    assert.dom(SECONDARY_CREATE_BUTTON).exists();
    assert.dom(PRIMARY_CREATE_BUTTON).doesNotExist();

    await fillIn(TITLE_INPUT, "Foo");

    assert.dom(SECONDARY_CREATE_BUTTON).doesNotExist();
    assert.dom(PRIMARY_CREATE_BUTTON).exists();
  });
});
