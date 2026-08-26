import { describe, expect, it } from "vitest";
import { builtinWorkflowCatalog } from "../src/builtins/catalog.js";
import { BuiltinWorkflowCatalog } from "../src/workflows/catalog.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { BuiltinWorkflowRevisionChangedError } from "../src/workflows/errors.js";
import { definitionDigest } from "../src/workflows/store.js";

function fixture(name = "fixture") {
  return defineWorkflow({
    name,
    startAt: "done",
    nodes: { done: compute({ run: () => true }) },
    edges: [],
  });
}

describe("BuiltinWorkflowCatalog", () => {
  it("ships the complete pinned built-in revision and digest matrix", () => {
    expect(
      Object.fromEntries(
        builtinWorkflowCatalog
          .list()
          .map((entry) => [entry.id, { revision: entry.revision, digest: entry.definitionDigest }]),
      ),
    ).toEqual({
      autoplan: {
        revision: "2",
        digest: "sha256:d24a183306754a6dd83e71b56976e9cbed13b19a919c3ae8fa43e010bf6aac11",
      },
      autodoc: {
        revision: "4",
        digest: "sha256:ed630127a5fe44f054111aa3b3c75c40c722e99160e681b7ce7030d76884b058",
      },
      autoimplement: {
        revision: "16",
        digest: "sha256:051abf4bf638e1f1984c19a6656da8057f64c0571c604e98eac500ede733385d",
      },
      "plan-approval": {
        revision: "4",
        digest: "sha256:fc52c790a4dc9d4f655a54675aaaaa06328e4adcec2c14c8b6f17bc082a1ddff",
      },
      "sanity-check": {
        revision: "3",
        digest: "sha256:ebebb86dc2eb83c4510dfb79840014b1d4d02a27974ecec9f080cabb05fae5df",
      },
      monitor: {
        revision: "12",
        digest: "sha256:375fb95c240443dd580bc5ea9da02b39678b8162296fa6bec51b526c25321bb7",
      },
    });
  });

  it("resolves a stable built-in source without reading a file", () => {
    const definition = fixture();
    const catalog = new BuiltinWorkflowCatalog([
      { id: "fixture", revision: "r1", definitionDigest: definitionDigest(definition), definition },
    ]);

    expect(catalog.resolve({ kind: "builtin", id: "fixture", revision: "r1" })).toBe(definition);
    expect(catalog.get("fixture")?.ref).toBe("builtin:fixture");
  });

  it("rejects changed revisions with restart guidance and duplicate identities", () => {
    const definition = fixture();
    const catalog = new BuiltinWorkflowCatalog([
      { id: "fixture", revision: "r1", definitionDigest: definitionDigest(definition), definition },
    ]);

    expect(() =>
      catalog.resolve({ kind: "builtin", id: "fixture", revision: "r2" }, "old-run"),
    ).toThrow(BuiltinWorkflowRevisionChangedError);
    expect(() =>
      catalog.resolve({ kind: "builtin", id: "fixture", revision: "r2" }, "old-run"),
    ).toThrow(/cancel run old-run, then start fixture again/);
    expect(
      () =>
        new BuiltinWorkflowCatalog([
          {
            id: "fixture",
            revision: "r1",
            definitionDigest: definitionDigest(definition),
            definition,
          },
          {
            id: "fixture",
            revision: "r2",
            definitionDigest: definitionDigest(fixture("other")),
            definition: fixture("other"),
          },
        ]),
    ).toThrow(/Duplicate built-in workflow id/);
  });

  it("rejects graph drift under a pinned revision and accepts a bumped matching pin", () => {
    const original = fixture();
    const changed = defineWorkflow({
      name: "fixture",
      startAt: "done",
      nodes: { done: compute({ timeoutMs: 1_000, run: () => true }) },
      edges: [],
    });
    const originalDigest = definitionDigest(original);

    expect(
      () =>
        new BuiltinWorkflowCatalog([
          {
            id: "fixture",
            revision: "r1",
            definitionDigest: originalDigest,
            definition: changed,
          },
        ]),
    ).toThrow(/Bump both its revision and checked-in definition digest/);
    expect(
      new BuiltinWorkflowCatalog([
        {
          id: "fixture",
          revision: "r2",
          definitionDigest: definitionDigest(changed),
          definition: changed,
        },
      ]).get("fixture"),
    ).toMatchObject({ revision: "r2", definitionDigest: definitionDigest(changed) });
  });

  it("matches only proved legacy paths and hashes", () => {
    const catalog = new BuiltinWorkflowCatalog([
      {
        id: "fixture",
        revision: "r1",
        definitionDigest: definitionDigest(fixture()),
        definition: fixture(),
        legacySources: [
          { workflowHash: "old", revision: "r1", pathSuffixes: ["/builtins/fixture.workflow.js"] },
        ],
      },
    ]);

    expect(
      catalog.matchLegacy({
        workflowName: "fixture",
        workflowPath: "/package/dist/builtins/fixture.workflow.js",
        workflowHash: "old",
      }),
    ).toMatchObject({ entry: { id: "fixture" }, revision: "r1" });
    expect(
      catalog.matchLegacy({
        workflowName: "fixture",
        workflowPath: "/project/fixture.workflow.js",
        workflowHash: "old",
      }),
    ).toBeUndefined();
    expect(
      catalog.legacyPathEntry({
        workflowName: "fixture",
        workflowPath: "/package/dist/builtins/fixture.workflow.js",
      })?.id,
    ).toBe("fixture");
    expect(
      catalog.matchLegacy({
        workflowName: "fixture",
        workflowPath: "/package/dist/builtins/fixture.workflow.js",
        workflowHash: "changed",
      }),
    ).toBeUndefined();
    expect(
      catalog.matchLegacy({
        workflowName: "fixture",
        workflowPath: "C:\\package\\dist\\builtins\\fixture.workflow.js",
        workflowHash: "old",
      })?.entry.id,
    ).toBe("fixture");
  });
});
