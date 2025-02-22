import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import { getOwner } from "@ember/application";
import { inject as service } from "@ember/service";
import {
  keepLatestTask,
  restartableTask,
  task,
  timeout,
} from "ember-concurrency";
import { capitalize, dasherize } from "@ember/string";
import cleanString from "hermes/utils/clean-string";
import { debounce } from "@ember/runloop";
import FetchService from "hermes/services/fetch";
import RouterService from "@ember/routing/router-service";
import SessionService from "hermes/services/session";
import FlashMessageService from "ember-cli-flash/services/flash-messages";
import { AuthenticatedUser } from "hermes/services/authenticated-user";
import {
  CustomEditableField,
  HermesDocument,
  HermesUser,
} from "hermes/types/document";
import { assert } from "@ember/debug";
import Route from "@ember/routing/route";
import Ember from "ember";
import htmlElement from "hermes/utils/html-element";
import ConfigService from "hermes/services/config";
import isValidURL from "hermes/utils/is-valid-u-r-l";
import { HermesDocumentType } from "hermes/types/document-type";

interface DocumentSidebarComponentSignature {
  Args: {
    profile: AuthenticatedUser;
    document: HermesDocument;
    docType: Promise<HermesDocumentType>;
    deleteDraft: (docId: string) => void;
    isCollapsed: boolean;
    toggleCollapsed: () => void;
  };
}

export enum DraftVisibility {
  Restricted = "restricted",
  Shareable = "shareable",
}

export enum DraftVisibilityIcon {
  Restricted = "lock",
  Shareable = "enterprise",
  Loading = "loading",
}

export enum DraftVisibilityDescription {
  Restricted = "Only you and the people you add can view and edit this doc.",
  Shareable = "Editing is restricted, but anyone in the organization with the link can view.",
}

const SHARE_BUTTON_SELECTOR = "#sidebar-header-copy-url-button";

export default class DocumentSidebarComponent extends Component<DocumentSidebarComponentSignature> {
  @service("config") declare configSvc: ConfigService;
  @service("fetch") declare fetchSvc: FetchService;
  @service declare router: RouterService;
  @service declare session: SessionService;
  @service declare flashMessages: FlashMessageService;

  @tracked archiveModalIsShown = false;
  @tracked deleteModalIsShown = false;
  @tracked requestReviewModalIsShown = false;
  @tracked docPublishedModalIsShown = false;
  @tracked docTypeCheckboxValue = false;
  @tracked emailFields = ["approvers", "contributors"];

  @tracked protected docType: HermesDocumentType | null = null;

  get modalIsShown() {
    return (
      this.archiveModalIsShown ||
      this.deleteModalIsShown ||
      this.requestReviewModalIsShown
    );
  }

  /**
   * Whether the doc is a draft.
   * If the draft was recently published, return false.
   * Otherwise use the passed-in isDraft property.
   */
  get isDraft() {
    return this.draftWasPublished ? false : this.args.document?.isDraft;
  }

  get docID() {
    return this.args.document?.objectID;
  }

  // TODO: This state tracking could be improved with a document model
  // (not necessarily, an ember data model, but some sort of tracking-aware
  // class to stuff this in instead of passing a POJO around).
  @tracked title = this.args.document.title || "";
  @tracked summary = this.args.document.summary || "";

  @tracked contributors: HermesUser[] =
    this.args.document.contributorObjects || [];

  @tracked approvers: HermesUser[] = this.args.document.approverObjects || [];
  @tracked product = this.args.document.product || "";

  /**
   * Whether a draft was published during the session.
   * Set true when the user successfully requests a review.
   * Used in the `isDraft` getter to immediately update the UI
   * to reflect the new state of the document.
   */
  @tracked private draftWasPublished: boolean | null = null;

  /**
   * Whether the `waitForDocNumber` task has has failed to find a docNumber.
   * When true, the "doc published" modal will not show a URL or share button.
   */
  @tracked protected docNumberLookupHasFailed = false;

  /**
   * Whether the draft's `isShareable` property is true.
   * Checked on render and changed when the user toggles permissions.
   * Used to
   */
  @tracked _docIsShareable = false;

  /**
   * The icon of a new draft visibility. Set immediately when
   * a draft-visibility option is selected and removed when the
   * request finally completes. Used to reactively update the UI.
   */
  @tracked private newDraftVisibilityIcon: DraftVisibilityIcon | null = null;

  @tracked userHasScrolled = false;
  @tracked _body: HTMLElement | null = null;

  /**
   * Whether the draft is shareable.
   * Used to identify the draft-visibility options
   * and determine which to show as checked.
   */
  protected get draftVisibility(): DraftVisibility {
    return this.draftIsShareable
      ? DraftVisibility.Shareable
      : DraftVisibility.Restricted;
  }

  protected get toggleDraftVisibilityTooltipText() {
    if (this.draftVisibilityIcon === DraftVisibilityIcon.Restricted) {
      return capitalize(DraftVisibility.Restricted);
    } else {
      return capitalize(DraftVisibility.Shareable);
    }
  }

  /**
   * The icon shown in the draft-visibility toggle.
   * If the initial draft permissions are loading, show a loading icon.
   * If the user has selected a new draft visibility, show that icon.
   * Otherwise, show the saved draft visibility icon.
   */
  protected get draftVisibilityIcon(): DraftVisibilityIcon {
    if (this.getDraftPermissions.isRunning) {
      return DraftVisibilityIcon.Loading;
    }
    if (this.newDraftVisibilityIcon) {
      return this.newDraftVisibilityIcon;
    }
    return this.draftIsShareable
      ? DraftVisibilityIcon.Shareable
      : DraftVisibilityIcon.Restricted;
  }

  /**
   * The URL that the copyURLButton should copy to the clipboard.
   * If the document is a draft, this is the current window location.
   * If the doc is published, use the short link if it's available,
   * otherwise use the current window location.s
   */
  protected get shareURL() {
    // We only assign shortLinks to published documents
    if (this.isDraft) {
      return window.location.href;
    }

    let shortLinkBaseURL: string | undefined =
      this.configSvc.config.short_link_base_url;

    if (shortLinkBaseURL) {
      // Add a trailing slash if the URL needs one
      if (!shortLinkBaseURL.endsWith("/")) {
        shortLinkBaseURL += "/";
      }
      // Reject invalid URLs
      if (!isValidURL(shortLinkBaseURL)) {
        shortLinkBaseURL = undefined;
      }
    }

    return shortLinkBaseURL
      ? `${
          shortLinkBaseURL + this.args.document.docType.toLowerCase()
        }/${this.args.document.docNumber.toLowerCase()}`
      : window.location.href;
  }

  /**
   * Whether the share button should be shown.
   * True if the document is published or the draft is shareable.
   * False otherwise.
   */
  protected get shareButtonIsShown(): boolean | undefined {
    if (!this.isDraft) {
      // Let the child component decide.
      return;
    }
    if (this._docIsShareable) {
      return true;
    }
    return false;
  }

  /**
   * Whether the draft is shareable.
   * True if the document is a draft and `isShareable`.
   */
  private get draftIsShareable() {
    return this.isDraft && this._docIsShareable;
  }

  get body() {
    assert("_body must exist", this._body);
    return this._body;
  }

  get docIsLocked() {
    return this.args.document?.locked;
  }

  get customEditableFields() {
    let customEditableFields = this.args.document.customEditableFields || {};
    for (const field in customEditableFields) {
      // @ts-ignore - TODO: Type this
      customEditableFields[field]["value"] = this.args.document[field];
    }
    return customEditableFields;
  }

  get approveButtonText() {
    if (!this.hasApproved) {
      return "Approve";
    } else {
      return "Already approved";
    }
  }

  get requestChangesButtonText() {
    // FRDs are a special case that can be approved or not approved.
    if (this.args.document.docType === "FRD") {
      if (!this.hasRequestedChanges) {
        return "Not approved";
      } else {
        return "Already not approved";
      }
    }

    if (!this.hasRequestedChanges) {
      return "Request changes";
    } else {
      return "Already requested changes";
    }
  }

  @action onDocTypeCheckboxChange(event: Event) {
    const eventTarget = event.target;
    assert(
      "event.target must be an HTMLInputElement",
      eventTarget instanceof HTMLInputElement,
    );
    this.docTypeCheckboxValue = eventTarget.checked;
  }

  get moveToStatusButtonColor() {
    switch (this.args.document.status) {
      case "In-Review":
        return "primary";
      default:
        return "secondary";
    }
  }

  // moveToStatusButtonTargetStatus returns the target status that the button
  // will move a document to.
  get moveToStatusButtonTargetStatus() {
    switch (this.args.document.status) {
      case "In-Review":
        return "Approved";
      default:
        return "In-Review";
    }
  }

  /**
   * The items passed to the draft-visibility dropdown.
   * Used to render the dropdown items and react to item selection.
   */
  protected get draftVisibilityOptions() {
    return {
      [DraftVisibility.Restricted]: {
        // need to uppercase the first letter of the title
        title: capitalize(DraftVisibility.Restricted),
        icon: DraftVisibilityIcon.Restricted,
        description: DraftVisibilityDescription.Restricted,
      },
      [DraftVisibility.Shareable]: {
        title: capitalize(DraftVisibility.Shareable),
        icon: DraftVisibilityIcon.Shareable,
        description: DraftVisibilityDescription.Shareable,
      },
    };
  }

  /**
   * Whether the share button is in the process of creating a shareable link.
   * Used to determine the icon and tooltip text of the share button.
   */
  private get isCreatingShareLink() {
    return (
      this.setDraftVisibility.isRunning &&
      this.newDraftVisibilityIcon === DraftVisibilityIcon.Shareable
    );
  }

  /**
   * The tooltip text to show in the share button
   * while the user is creating or has recently created a shareable link.
   */
  protected get temporaryShareButtonTooltipText() {
    if (this.isCreatingShareLink) {
      return "Creating link...";
    }
    if (this.showCreateLinkSuccessMessage.isRunning) {
      return "Link created!";
    }
  }

  /**
   * The icon to show in the share button while the user is
   * creating a shareable link. Shows the "running" animation while
   * the request works; switches to a "smile" when the request completes.
   */
  protected get temporaryShareButtonIcon() {
    if (this.isCreatingShareLink) {
      return "running";
    }
    if (this.showCreateLinkSuccessMessage.isRunning) {
      return "smile";
    }
  }

  get moveToStatusButtonText() {
    return `Move to ${this.moveToStatusButtonTargetStatus}`;
  }

  // isApprover returns true if the logged in user is a document approver.
  get isApprover() {
    return this.args.document.approvers?.some(
      (e) => e === this.args.profile.email,
    );
  }

  get isContributor() {
    return this.args.document.contributors?.some(
      (e) => e === this.args.profile.email,
    );
  }

  // hasApproved returns true if the logged in user has approved the document.
  get hasApproved() {
    return this.args.document.approvedBy?.includes(this.args.profile.email);
  }

  // hasRequestedChanges returns true if the logged in user has requested
  // changes of the document.
  get hasRequestedChanges() {
    return this.args.document.changesRequestedBy?.includes(
      this.args.profile.email,
    );
  }

  /**
   * Whether the doc status is approved. Used to determine editing privileges.
   * If the doc is approved, editing is exclusive to the doc owner.
   */
  private get docIsApproved() {
    return this.args.document.status.toLowerCase() === "approved";
  }

  /**
   * Whether the doc status is in review. Used to determine editing privileges.
   * If the doc is in review, editing is exclusive to the doc owner.
   */
  private get docIsInReview() {
    return dasherize(this.args.document.status) === "in-review";
  }

  /**
   * Whether the document viewer is its owner.
   * True if the logged in user's email matches the documents owner.
   */
  protected get isOwner() {
    return this.args.document.owners?.[0] === this.args.profile.email;
  }

  /**
   * Whether the editing of document metadata allowed, excluding the
   * product/area field, which is disallowed for published docs.
   * If the doc is locked, editing is disabled and a message is shown
   * explaining that suggestions must be removed from the header.
   *
   * If the doc was created off-app, editing is disabled and a message
   * is shown explaining that only app-created docs can be edited.
   *
   * If the doc is in a known state, e.g., draft, in review, or approved,
   * editing is disabled for non-doc-owners.
   *
   * If the doc is in an unknown state, editing is disabled.
   */
  protected get editingIsDisabled() {
    if (this.docIsLocked) {
      return true;
    }

    if (!this.args.document.appCreated) {
      return true;
    }

    if (this.isDraft || this.docIsInReview || this.docIsApproved) {
      return !this.isOwner;
    } else {
      return true;
    }
  }

  /**
   * Whether the footer controls are disabled.
   * True if the doc is locked or was created off-app.
   * Determines if we show controls like "approve" and "request changes"
   * or a message explaining their absence.
   */
  protected get footerControlsAreDisabled() {
    if (this.docIsLocked || !this.args.document.appCreated) {
      return true;
    }
  }

  /**
   * Whether the footer is shown.
   * True for editors who may need to see the "doc is locked" message,
   * as well as approvers and owners who need doc-management controls.
   */
  protected get footerIsShown() {
    return this.isApprover || this.isOwner || this.isContributor;
  }

  /**
   * Whether editing is enabled for basic metadata fields.
   * Used in the template to make some logic more readable.
   */
  protected get editingIsEnabled() {
    return !this.editingIsDisabled;
  }

  @action refreshRoute() {
    // We force refresh due to a bug with `refreshModel: true`
    // See: https://github.com/emberjs/ember.js/issues/19260
    const owner = getOwner(this);
    assert("owner must exist", owner);
    const route = owner.lookup(
      `route:${this.router.currentRouteName}`,
    ) as Route;
    assert("route must exist", route);
    route.refresh();
  }

  @action maybeShowFlashError(error: Error, title: string) {
    if (!this.modalIsShown) {
      this.showFlashError(error, title);
    }
  }

  showFlashError(error: Error, title: string) {
    this.flashMessages.add({
      title,
      message: error.message,
      type: "critical",
      timeout: 6000,
      extendedTimeout: 1000,
      preventDuplicates: true,
    });
  }

  @action showFlashSuccess(title: string, message: string) {
    this.flashMessages.add({
      message,
      title,
      type: "success",
      timeout: 6000,
      extendedTimeout: 1000,
    });
  }

  /**
   * A task that waits for a short time and then resolves.
   * Used to trigger the "link created" state of the share button.
   */
  protected showCreateLinkSuccessMessage = restartableTask(async () => {
    await timeout(Ember.testing ? 0 : 1000);
  });

  /**
   * Sets the draft's `isShareable` property based on a selection
   * in the draft-visibility dropdown. Immediately updates the UI
   * to reflect the intended change while a request is made to the
   * back end. Once the request completes, the UI is updated again
   * to reflect the actual state of the document.
   */
  protected setDraftVisibility = restartableTask(
    async (newVisibility: DraftVisibility) => {
      if (this.draftVisibility === newVisibility) {
        return;
      }

      try {
        if (newVisibility === DraftVisibility.Restricted) {
          this.newDraftVisibilityIcon = DraftVisibilityIcon.Restricted;

          const shareButton = htmlElement(SHARE_BUTTON_SELECTOR);

          shareButton.classList.add("out");

          void this.fetchSvc.fetch(
            `/api/${this.configSvc.config.api_version}/drafts/${this.docID}/shareable`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                isShareable: false,
              }),
            },
          );

          // Give time for the link icon to animate out
          await timeout(Ember.testing ? 0 : 300);

          // With the animation done, we can now remove the button.
          this._docIsShareable = false;
        } else {
          // Immediately update the UI to show the share button
          // in its "creating link" state.
          this.newDraftVisibilityIcon = DraftVisibilityIcon.Shareable;
          this._docIsShareable = true;

          await this.fetchSvc.fetch(
            `/api/${this.configSvc.config.api_version}/drafts/${this.docID}/shareable`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                isShareable: true,
              }),
            },
          );

          // Kick off the timer for the "link created" state.
          void this.showCreateLinkSuccessMessage.perform();
        }
      } catch (error: unknown) {
        this.showFlashError(
          error as Error,
          "Unable to update draft visibility",
        );
      } finally {
        // reset the new-visibility-intent icon
        this.newDraftVisibilityIcon = null;
      }
    },
  );

  saveProduct = keepLatestTask(async (product: string) => {
    this.product = product;
    await this.save.perform("product", this.product);
    // productAbbreviation is computed by the back end
  });

  get saveIsRunning() {
    return (
      this.save.isRunning ||
      this.saveCustomField.isRunning ||
      this.saveProduct.isRunning
    );
  }

  save = task(async (field: string, val: string | HermesUser[]) => {
    if (field && val !== undefined) {
      let serializedValue;

      if (typeof val === "string") {
        serializedValue = cleanString(val);
      } else {
        serializedValue = val.map((p: HermesUser) => p.email);
      }

      try {
        await this.patchDocument.perform({
          [field]: serializedValue,
        });
      } catch (err) {
        this.showFlashError(err as Error, "Unable to save document");
      }
    }
  });

  saveCustomField = task(
    async (
      fieldName: string,
      field: CustomEditableField,
      val: string | string[],
    ) => {
      if (field && val !== undefined) {
        let serializedValue;

        if (typeof val === "string") {
          serializedValue = cleanString(val);
        } else {
          serializedValue = val;
        }

        field.name = fieldName;
        field.value = serializedValue;

        try {
          await this.patchDocument.perform({
            customFields: [field],
          });
        } catch (err) {
          this.showFlashError(err as Error, "Unable to save document");
        }
      }
    },
  );

  patchDocument = task(async (fields) => {
    const endpoint = this.isDraft ? "drafts" : "documents";

    try {
      await this.fetchSvc.fetch(
        `/api/${this.configSvc.config.api_version}/${endpoint}/${this.docID}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fields),
        },
      );
    } catch (error: unknown) {
      this.maybeShowFlashError(error as Error, "Unable to save document");
      throw error;
    } finally {
      this.refreshRoute();
    }
  });

  requestReview = task(async () => {
    try {
      // Update approvers.
      await this.patchDocument.perform({
        approvers: this.approvers?.compact().mapBy("email"),
      });

      await this.fetchSvc.fetch(
        `/api/${this.configSvc.config.api_version}/reviews/${this.docID}`,
        {
          method: "POST",
        },
      );

      this.router.transitionTo({
        queryParams: { draft: false },
      });

      this.refreshRoute();

      await this.waitForDocNumber.perform();
      this.draftWasPublished = true;
      this.requestReviewModalIsShown = false;
      this.docPublishedModalIsShown = true;
    } catch (error: unknown) {
      this.draftWasPublished = null;
      this.maybeShowFlashError(error as Error, "Unable to request review");
      throw error;
    }
  });

  /**
   * A task that awaits a newly published doc's docNumber assignment.
   * In the unlikely case where the docNumber doesn't appear after 10 seconds,
   * we remove the URL and share button from the "doc published" modal.
   */
  private waitForDocNumber = task(async () => {
    const numberOfTries = 10;

    for (let i = 0; i < numberOfTries; i++) {
      if (!this.args.document.docNumber.endsWith("?")) {
        return;
      } else {
        await timeout(Ember.testing ? 0 : 1000);
      }
    }

    this.docNumberLookupHasFailed = true;
  });

  deleteDraft = task(async () => {
    try {
      await this.args.deleteDraft(this.docID);
    } catch (error: unknown) {
      this.maybeShowFlashError(error as Error, "Unable to delete draft");
      throw error;
    }
  });

  @action updateApprovers(approvers: HermesUser[]) {
    this.approvers = approvers;
  }

  @action updateContributors(contributors: HermesUser[]) {
    this.contributors = contributors;
  }

  @action saveTitle(title: string) {
    this.title = title;
    void this.save.perform("title", this.title);
  }

  @action saveSummary(summary: string) {
    this.summary = summary;
    void this.save.perform("summary", this.summary);
  }

  @action closeDeleteModal() {
    this.deleteModalIsShown = false;
  }

  @action closeRequestReviewModal() {
    this.requestReviewModalIsShown = false;
  }

  @action closeArchiveModal() {
    this.archiveModalIsShown = false;
  }

  @action protected closeRequestReviewSuccessModal() {
    this.requestReviewModalIsShown = false;
  }

  @action onScroll() {
    let onScrollFunction = () => {
      this.userHasScrolled = this.body.scrollTop > 0;
    };

    debounce(this, onScrollFunction, 50);
  }

  /**
   * Registers the body element locally and, if the document is a draft,
   * kicks off the task to fetch the draft's `isShareable` attribute.
   */
  @action protected didInsertBody(element: HTMLElement) {
    this._body = element;

    if (this.isDraft) {
      // kick off whether the draft is shareable.
      void this.getDraftPermissions.perform();

      // get docType for the "request review?" modal
      this.args.docType.then((docType) => {
        this.docType = docType;
      });
    }
  }

  /**
   * Fetches the draft's `isShareable` attribute and updates the local property.
   * Called when a document draft is rendered.
   */
  private getDraftPermissions = task(async () => {
    try {
      const response = await this.fetchSvc
        .fetch(
          `/api/${this.configSvc.config.api_version}/drafts/${this.docID}/shareable`,
        )
        .then((response) => response?.json());
      if (response?.isShareable) {
        this._docIsShareable = true;
      }
    } catch {}
  });

  approve = task(async () => {
    try {
      await this.fetchSvc.fetch(
        `/api/${this.configSvc.config.api_version}/approvals/${this.docID}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      this.showFlashSuccess("Done!", "Document approved");
    } catch (error: unknown) {
      this.maybeShowFlashError(error as Error, "Unable to approve");
      throw error;
    }

    this.refreshRoute();
  });

  requestChanges = task(async () => {
    try {
      await this.fetchSvc.fetch(
        `/api/${this.configSvc.config.api_version}/approvals/${this.docID}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
        },
      );
      // Add a notification for the user
      let msg = "Requested changes for document";
      // FRDs are a special case that can be approved or not approved.
      if (this.args.document.docType === "FRD") {
        msg = "Document marked as not approved";
      }
      this.showFlashSuccess("Done!", msg);
    } catch (error: unknown) {
      this.maybeShowFlashError(error as Error, "Change request failed");
      throw error;
    }
    this.refreshRoute();
  });

  changeDocumentStatus = task(async (status) => {
    try {
      await this.patchDocument.perform({
        status: status,
      });
      this.showFlashSuccess("Done!", `Document status changed to "${status}"`);
    } catch (error: unknown) {
      this.maybeShowFlashError(
        error as Error,
        "Unable to change document status",
      );
      throw error;
    }
    this.refreshRoute();
  });
}

declare module "@glint/environment-ember-loose/registry" {
  export default interface Registry {
    "Document::Sidebar": typeof DocumentSidebarComponent;
  }
}
