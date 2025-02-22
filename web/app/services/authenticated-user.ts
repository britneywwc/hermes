import Service from "@ember/service";
import { tracked } from "@glimmer/tracking";
import { inject as service } from "@ember/service";
import Store from "@ember-data/store";
import { assert } from "@ember/debug";
import { task } from "ember-concurrency";
import ConfigService from "hermes/services/config";
import FetchService from "hermes/services/fetch";
import SessionService from "./session";

export interface AuthenticatedUser {
  name: string;
  email: string;
  given_name: string;
  picture: string;
  subscriptions: Subscription[];
}

export interface Subscription {
  productArea: string;
  subscriptionType: SubscriptionType;
}

enum SubscriptionType {
  Digest = "digest",
  Instant = "instant",
}

export default class AuthenticatedUserService extends Service {
  @service("config") declare configSvc: ConfigService;
  @service("fetch") declare fetchSvc: FetchService;
  @service declare session: SessionService;
  @service declare store: Store;

  @tracked subscriptions: Subscription[] | null = null;
  @tracked _info: AuthenticatedUser | null = null;

  get info(): AuthenticatedUser {
    assert("Authenticated must exist", this._info);
    return this._info;
  }

  /**
   * Returns the user's subscriptions as a JSON string.
   * E.g., '{"subscriptions":["Customer Success", "Terraform"]}'
   * Used in POST requests to the subscriptions endpoint.
   */
  private get subscriptionsPostBody(): string {
    assert("subscriptions must be defined", this.subscriptions);
    let subscriptions = this.subscriptions.map(
      (subscription: Subscription) => subscription.productArea,
    );
    return JSON.stringify({ subscriptions });
  }

  /**
   * The headers to use in POST requests to the subscriptions endpoint.
   */
  private get subscriptionsPostHeaders() {
    return {
      "Content-Type": "application/json",
    };
  }

  /**
   * Loads the user's info from the Google API.
   * Called by `session.handleAuthentication` and `authenticated.afterModel`.
   * Ensures `authenticatedUser.info` is always defined and up-to-date
   * in any route that needs it. On error, bubbles up to the application route.
   */
  loadInfo = task(async () => {
    try {
      this._info = await this.fetchSvc
        .fetch(`/api/${this.configSvc.config.api_version}/me`)
        .then((response) => response?.json());
    } catch (e: unknown) {
      console.error("Error getting user information: ", e);
      throw e;
    }
  });

  /**
   * Loads the user's subscriptions from the API.
   * If the user has no subscriptions, returns an empty array.
   */
  fetchSubscriptions = task(async () => {
    try {
      let subscriptions = await this.fetchSvc
        .fetch(`/api/${this.configSvc.config.api_version}/me/subscriptions`, {
          method: "GET",
        })
        .then((response) => response?.json());

      let newSubscriptions: Subscription[] = [];

      if (subscriptions) {
        newSubscriptions = subscriptions.map((subscription: string) => {
          return {
            productArea: subscription,
            subscriptionType: SubscriptionType.Instant,
          };
        });
      }
      this.subscriptions = newSubscriptions;
    } catch (e: unknown) {
      console.error("Error loading subscriptions: ", e);
      throw e;
    }
  });

  /**
   * Adds a subscription and saves the subscription index.
   * Subscriptions default to the "instant" subscription type.
   */
  addSubscription = task(
    async (
      productArea: string,
      subscriptionType = SubscriptionType.Instant,
    ) => {
      assert(
        "removeSubscription expects a valid subscriptions array",
        this.subscriptions,
      );

      let cached = this.subscriptions;

      this.subscriptions.addObject({
        productArea,
        subscriptionType,
      });

      try {
        await this.fetchSvc.fetch(
          `/api/${this.configSvc.config.api_version}/me/subscriptions`,
          {
            method: "POST",
            headers: this.subscriptionsPostHeaders,
            body: this.subscriptionsPostBody,
          },
        );
      } catch (e: unknown) {
        console.error("Error updating subscriptions: ", e);
        this.subscriptions = cached;
        throw e;
      }
    },
  );

  /**
   * Removes a subscription and saves the subscription index.
   */
  removeSubscription = task(
    async (
      productArea: string,
      subscriptionType = SubscriptionType.Instant,
    ) => {
      assert(
        "removeSubscription expects a subscriptions array",
        this.subscriptions,
      );

      let cached = this.subscriptions;
      let subscriptionToRemove = this.subscriptions.find(
        (subscription) => subscription.productArea === productArea,
      );

      assert(
        "removeSubscription expects a valid productArea",
        subscriptionToRemove,
      );

      this.subscriptions.removeObject(subscriptionToRemove);

      try {
        await this.fetchSvc.fetch(
          `/api/${this.configSvc.config.api_version}/me/subscriptions`,
          {
            method: "POST",
            headers: this.subscriptionsPostHeaders,
            body: this.subscriptionsPostBody,
          },
        );
      } catch (e: unknown) {
        console.error("Error updating subscriptions: ", e);
        this.subscriptions = cached;
        throw e;
      }
    },
  );
}
