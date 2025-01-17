/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { RemotePageChild } from "resource://gre/actors/RemotePageChild.sys.mjs";

import { ShoppingProduct } from "chrome://global/content/shopping/ShoppingProduct.mjs";

let lazy = {};

let gAllActors = new Set();

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "optedIn",
  "browser.shopping.experience2023.optedIn",
  null,
  function optedInStateChanged() {
    for (let actor of gAllActors) {
      actor.optedInStateChanged();
    }
  }
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "adsEnabled",
  "browser.shopping.experience2023.ads.enabled",
  true
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "adsEnabledByUser",
  "browser.shopping.experience2023.ads.userEnabled",
  true,
  function adsEnabledByUserChanged() {
    for (let actor of gAllActors) {
      actor.adsEnabledByUserChanged();
    }
  }
);

export class ShoppingSidebarChild extends RemotePageChild {
  constructor() {
    super();
  }

  actorCreated() {
    super.actorCreated();
    gAllActors.add(this);
  }

  didDestroy() {
    this._destroyed = true;
    super.didDestroy?.();
    gAllActors.delete(this);
    this.#product?.uninit();
  }

  #productURI = null;
  #product = null;

  receiveMessage(message) {
    switch (message.name) {
      case "ShoppingSidebar:UpdateProductURL":
        let { url } = message.data;
        let uri = url ? Services.io.newURI(url) : null;
        // If we're going from null to null, bail out:
        if (!this.#productURI && !uri) {
          return;
        }
        // Otherwise, check if we now have a product:
        if (uri && this.#productURI?.equalsExceptRef(uri)) {
          return;
        }
        this.#productURI = uri;
        this.updateContent({ haveUpdatedURI: true });
        break;
    }
  }

  handleEvent(event) {
    switch (event.type) {
      case "ContentReady":
        this.updateContent();
        break;
      case "PolledRequestMade":
        this.updateContent({ isPolledRequest: true });
        break;
      case "ShoppingTelemetryEvent":
        this.submitShoppingEvent(event.detail);
        break;
    }
  }

  get canFetchAndShowData() {
    return lazy.optedIn === 1;
  }

  get canFetchAndShowAd() {
    return lazy.adsEnabled;
  }

  get userHasAdsEnabled() {
    return lazy.adsEnabledByUser;
  }

  optedInStateChanged() {
    // Force re-fetching things if needed by clearing the last product URI:
    this.#productURI = null;
    // Then let content know.
    this.updateContent();
  }

  adsEnabledByUserChanged() {
    this.sendToContent("adsEnabledByUserChanged", {
      adsEnabledByUser: this.userHasAdsEnabled,
    });
  }

  getProductURI() {
    return this.#productURI;
  }

  /**
   * This callback is invoked whenever something changes that requires
   * re-rendering content. The expected cases for this are:
   * - page navigations (both to new products and away from a product once
   *   the sidebar has been created)
   * - opt in state changes.
   *
   * @param {object?} options
   *        Optional parameter object.
   * @param {bool} options.haveUpdatedURI = false
   *        Whether we've got an up-to-date URI already. If true, we avoid
   *        fetching the URI from the parent, and assume `this.#productURI`
   *        is current. Defaults to false.
   *
   */
  async updateContent({
    haveUpdatedURI = false,
    isPolledRequest = false,
  } = {}) {
    // updateContent is an async function, and when we're off making requests or doing
    // other things asynchronously, the actor can be destroyed, the user
    // might navigate to a new page, the user might disable the feature ... -
    // all kinds of things can change. So we need to repeatedly check
    // whether we can keep going with our async processes. This helper takes
    // care of these checks.
    let canContinue = (currentURI, checkURI = true) => {
      if (this._destroyed || !this.canFetchAndShowData) {
        return false;
      }
      if (!checkURI) {
        return true;
      }
      return currentURI && currentURI == this.#productURI;
    };
    this.#product?.uninit();
    // We are called either because the URL has changed or because the opt-in
    // state has changed. In both cases, we want to clear out content
    // immediately, without waiting for potentially async operations like
    // obtaining product information.
    // Do not clear data however if an analysis was requested via a call-to-action.
    if (!isPolledRequest) {
      this.sendToContent("Update", {
        adsEnabled: this.canFetchAndShowAd,
        adsEnabledByUser: this.userHasAdsEnabled,
        showOnboarding: !this.canFetchAndShowData,
        data: null,
        recommendationData: null,
      });
    }
    if (this.canFetchAndShowData) {
      if (!this.#productURI) {
        // If we already have a URI and it's just null, bail immediately.
        if (haveUpdatedURI) {
          return;
        }
        let url = await this.sendQuery("GetProductURL");

        // Bail out if we opted out in the meantime, or don't have a URI.
        if (!canContinue(null, false)) {
          return;
        }

        this.#productURI = Services.io.newURI(url);
      }

      let uri = this.#productURI;
      this.#product = new ShoppingProduct(uri);
      let data;
      let isPolledRequestDone;
      try {
        if (!isPolledRequest) {
          data = await this.#product.requestAnalysis();
        } else {
          data = await this.#product.pollForAnalysisCompleted();
          isPolledRequestDone = true;
        }
      } catch (err) {
        console.error("Failed to fetch product analysis data", err);
        data = { error: err };
      }
      // Check if we got nuked from orbit, or the product URI or opt in changed while we waited.
      if (!canContinue(uri)) {
        return;
      }
      this.sendToContent("Update", {
        showOnboarding: false,
        data,
        productUrl: this.#productURI.spec,
        isPolledRequestDone,
      });

      if (data.error) {
        return;
      }
      this.#product.requestRecommendations().then(recommendationData => {
        // Check if the product URI or opt in changed while we waited.
        if (uri != this.#productURI || !this.canFetchAndShowData) {
          return;
        }

        this.sendToContent("Update", {
          adsEnabled: this.canFetchAndShowAd,
          adsEnabledByUser: this.userHasAdsEnabled,
          showOnboarding: false,
          data,
          productUrl: this.#productURI.spec,
          recommendationData,
          isPolledRequestDone,
        });
      });
    } else {
      let url = await this.sendQuery("GetProductURL");

      // Similar to canContinue() above, check to see if things
      // have changed while we were waiting. Bail out if the user
      // opted in, or if the actor doesn't exist.
      if (this._destroyed || this.canFetchAndShowData) {
        return;
      }

      this.#productURI = Services.io.newURI(url);
      // Send the productURI to content for Onboarding's dynamic text
      this.sendToContent("Update", {
        showOnboarding: true,
        data: null,
        productUrl: this.#productURI.spec,
      });
    }
  }

  sendToContent(eventName, detail) {
    if (this._destroyed) {
      return;
    }
    let win = this.contentWindow;
    let evt = new win.CustomEvent(eventName, {
      bubbles: true,
      detail: Cu.cloneInto(detail, win),
    });
    win.document.dispatchEvent(evt);
  }

  /**
   * Helper to handle telemetry events.
   *
   * @param {string | Array} message
   *        Which Glean event to record too. If an array is used, the first
   *        element should be the message and the second the additional detail
   *        to record.
   */
  submitShoppingEvent(message) {
    // We are currently working through an actor to record Glean events and
    // this function is where we will direct a custom actor event into the
    // correct Glean event. However, this is an unpleasant solution and one
    // that should not be replicated. Please reference bug 1848708 for more
    // detail about why.
    let details;
    if (Array.isArray(message)) {
      details = message[1];
      message = message[0];
    }
    switch (message) {
      case "shopping-settings-label":
        Glean.shopping.surfaceSettingsExpandClicked.record({ action: details });
        break;
      case "shopping-analysis-explainer-label":
        Glean.shopping.surfaceShowQualityExplainerClicked.record({
          action: details,
        });
        break;
      case "reanalyzeClicked":
        Glean.shopping.surfaceReanalyzeClicked.record();
        break;
      case "surfaceClosed":
        Glean.shopping.surfaceClosed.record({ source: details });
        break;
      case "surfaceShowMoreReviewsButtonClicked":
        Glean.shopping.surfaceShowMoreReviewsButtonClicked.record({
          action: details,
        });
        break;
    }
  }
}
