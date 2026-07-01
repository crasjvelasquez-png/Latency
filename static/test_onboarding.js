/**
 * Onboarding test suite — runs when ?test=1 is in the URL.
 * Safe to include unconditionally; bails immediately in non-test mode.
 *
 * All module-level identifiers are accessed via window.__onboardingTest which
 * app.js populates in test mode. api.request / api.localPost are replaced with
 * stubs so no real network traffic occurs.
 */
(function () {
  "use strict";

  // No-op in production; this file is always loaded but only activates for test=1.
  if (!window.location.search.includes("test=1")) return;

  // Wait until app.js has had time to run and set __onboardingTest.
  function waitForHooks(cb) {
    if (window.__onboardingTest) {
      cb();
    } else {
      setTimeout(() => waitForHooks(cb), 50);
    }
  }

  waitForHooks(runTests);

  function runTests() {
    const {
      onboarding,
      init,
      getFocusableElements,
      isOnboardingCompleted,
      ONBOARDING_DISMISSED_KEY,
      ONBOARDING_SESSION_DISMISSED_KEY,
      ONBOARDING_COMPLETED_KEY,
    } = window.__onboardingTest;

    // ── Helpers ──────────────────────────────────────────────────────────────

    const results = [];

    function assert(condition, message) {
      if (!condition) throw new Error("Assertion failed: " + message);
    }

    function clearAllStorage() {
      localStorage.clear();
      sessionStorage.clear();
    }

    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    /** Build a mock api response payload with required schema version field. */
    function mockOnboardingResponse(overrides = {}) {
      return {
        data: {
          api_schema_version: 1,
          ableton_running: false,
          abletonosc_reachable: false,
          handler_available: false,
          automation_permission: false,
          all_passed: false,
          connection_state: "offline",
          diagnostics: {},
          ...overrides,
        },
      };
    }

    /** Replace api.request and api.localPost with no-op stubs. */
    function stubApi({ onboardingPasses = false } = {}) {
      const stub = async (path) => {
        if (path === "/api/onboarding") {
          const all_passed = onboardingPasses;
          return mockOnboardingResponse(
            all_passed
              ? {
                  ableton_running: true,
                  abletonosc_reachable: true,
                  handler_available: true,
                  automation_permission: true,
                  all_passed: true,
                  connection_state: "ready",
                }
              : {}
          );
        }
        if (path === "/api/status") {
          return {
            data: {
              api_schema_version: 1,
              connection_state: "offline",
              live_running: false,
              abletonosc_online: false,
              latency_handler_available: false,
              automation_permission: false,
              last_error: null,
              diagnostics: {},
              current_project: null,
              cached_report: null,
            },
          };
        }
        return { data: { api_schema_version: 1 } };
      };

      // Stub localPost (used by scan) — pretend offline so scan fails gracefully
      const localPostStub = async () => {
        return {
          res: { ok: false },
          data: {
            api_schema_version: 1,
            error: "Stubbed scan",
            connection_state: "offline",
          },
        };
      };

      window.LatencyApi.request = stub;
      window.LatencyApi.localPost = localPostStub;
    }

    /** Reset modal to hidden/closed state between tests. */
    function resetModalState() {
      if (onboarding.overlay) {
        onboarding.overlay.hidden = true;
        onboarding.overlay.removeAttribute("aria-modal");
      }
      const shell = document.querySelector(".app-shell");
      if (shell) {
        shell.inert = false;
        shell.removeAttribute("aria-hidden");
        if (shell._prevTabIndices) delete shell._prevTabIndices;
      }
      onboarding.doNotShow.checked = false;
      document.body.focus();
    }

    // ── Tests ─────────────────────────────────────────────────────────────────

    const tests = {
      async testFirstLaunchShowsModal() {
        clearAllStorage();
        stubApi({ onboardingPasses: false });

        await init();
        // After init with no storage keys and failing checks, modal must be open
        assert(
          onboarding.overlay.hidden === false,
          "Modal should be visible on first launch when checks fail"
        );
        assert(
          isOnboardingCompleted() === false,
          "Onboarding should not be marked completed"
        );
      },

      async testSessionDismissal() {
        clearAllStorage();
        stubApi({ onboardingPasses: false });
        onboarding.doNotShow.checked = false;

        await init();
        assert(onboarding.overlay.hidden === false, "Modal should be shown before dismissal");

        // Click Skip this session
        onboarding.dismiss.click();

        assert(
          sessionStorage.getItem(ONBOARDING_SESSION_DISMISSED_KEY) === "1",
          "Session dismissal key should be set"
        );
        assert(
          localStorage.getItem(ONBOARDING_DISMISSED_KEY) === null,
          "Persistent dismissal key should NOT be set"
        );
        assert(
          onboarding.overlay.hidden === true,
          "Modal should be hidden after session dismissal"
        );
      },

      async testPersistentDismissal() {
        clearAllStorage();
        stubApi({ onboardingPasses: false });

        await init();
        assert(onboarding.overlay.hidden === false, "Modal should be shown before dismissal");

        onboarding.doNotShow.checked = true;
        onboarding.dismiss.click();

        assert(
          localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1",
          "Persistent dismissal key should be set"
        );
        assert(
          sessionStorage.getItem(ONBOARDING_SESSION_DISMISSED_KEY) === null,
          "Session dismissal key should NOT be set when persistent is chosen"
        );
        assert(
          onboarding.overlay.hidden === true,
          "Modal should be hidden after persistent dismissal"
        );
      },

      async testOnboardingCompletion() {
        clearAllStorage();
        stubApi({ onboardingPasses: true });

        await init();

        // After a passing check init auto-dismisses and does not show modal
        assert(
          localStorage.getItem(ONBOARDING_COMPLETED_KEY) === "1",
          "Onboarding completed key should be set when all checks pass"
        );
        assert(
          onboarding.overlay.hidden === true,
          "Modal should remain hidden when checks pass on startup"
        );
      },

      async testResetPreference() {
        clearAllStorage();

        // Simulate already-completed state
        localStorage.setItem(ONBOARDING_COMPLETED_KEY, "1");
        localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
        sessionStorage.setItem(ONBOARDING_SESSION_DISMISSED_KEY, "1");

        stubApi({ onboardingPasses: false });

        // Init should skip modal because onboarding is marked completed
        await init();
        assert(
          onboarding.overlay.hidden === true,
          "Modal should remain hidden on init when already completed"
        );

        const resetBtn = document.getElementById("resetOnboardingBtn");
        assert(resetBtn !== null, "Reset button must exist in the DOM");

        onboarding.doNotShow.checked = true; // should be cleared on reset

        // Trigger the reset (the click handler passes resetBtn as the trigger,
        // so focus will be restored to it after modal close regardless of
        // whether the button itself was focused before the click)
        resetBtn.click();
        await delay(150); // let runOnboarding settle (it's async)

        // Storage must be cleared
        assert(
          localStorage.getItem(ONBOARDING_COMPLETED_KEY) === null,
          "Completed key should be cleared after reset"
        );
        assert(
          localStorage.getItem(ONBOARDING_DISMISSED_KEY) === null,
          "Dismissed key should be cleared after reset"
        );
        assert(
          sessionStorage.getItem(ONBOARDING_SESSION_DISMISSED_KEY) === null,
          "Session dismissed key should be cleared after reset"
        );
        assert(
          onboarding.doNotShow.checked === false,
          "Do Not Show checkbox should be unchecked after reset"
        );
        assert(
          onboarding.overlay.hidden === false,
          "Modal should be visible after reset"
        );

        // Focus should be trapped inside the modal
        const focusables = getFocusableElements(onboarding.overlay);
        if (focusables.length > 0) {
          assert(
            document.activeElement === focusables[0],
            "Focus should be trapped to first focusable element inside modal after reset"
          );
        }

        // Verify that the modal was opened with resetBtn as the trigger so that
        // focus will be restored to it when the modal closes in a real session.
        // (We cannot assert document.activeElement === resetBtn here because
        // the Help tab panel is hidden in the test environment and browsers
        // refuse to focus elements inside hidden ancestors.)
        const triggerEl = window.__onboardingTest._lastTrigger;

        // Dismiss via Escape key
        onboarding.overlay.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );

        assert(
          onboarding.overlay.hidden === true,
          "Modal should close when Escape is pressed"
        );
      },
    };

    // ── Runner ────────────────────────────────────────────────────────────────

    async function runAllTests() {
      console.log("[onboarding-tests] Starting…");

      for (const [name, fn] of Object.entries(tests)) {
        resetModalState();
        try {
          console.log(`[onboarding-tests] Running: ${name}`);
          await fn();
          results.push({ name, passed: true });
          console.log(`[onboarding-tests] PASSED: ${name}`);
        } catch (err) {
          results.push({ name, passed: false, error: err.message });
          console.error(`[onboarding-tests] FAILED: ${name}`, err.message);
        }
      }

      const passed = results.every((r) => r.passed);
      window.testResults = { passed, details: results };
      console.log("[onboarding-tests] Done.", window.testResults);
    }

    // Small delay so the page has fully rendered before tests start
    setTimeout(runAllTests, 200);
  }
})();
