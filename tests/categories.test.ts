import { describe, it, expect } from "vitest";
import {
  CATEGORIES,
  CATEGORY_OVERRIDES,
  categoryForOperation,
  safetyBucket,
} from "../src/categories.js";

describe("categoryForOperation", () => {
  it("defaults sensibly by HTTP method", () => {
    expect(categoryForOperation("get", "/crm/v3/objects/contacts").id).toBe("read");
    expect(categoryForOperation("post", "/crm/v3/objects/contacts").id).toBe("create");
    expect(categoryForOperation("patch", "/crm/v3/objects/contacts/{id}").id).toBe("update");
    expect(categoryForOperation("put", "/cms/v3/hubdb/tables/{id}").id).toBe("update");
    expect(categoryForOperation("delete", "/crm/v3/objects/contacts/{id}").id).toBe("delete");
  });

  it("labels POST searches and batch reads as read-only queries", () => {
    expect(categoryForOperation("post", "/crm/v3/objects/contacts/search").id).toBe("query");
    expect(categoryForOperation("post", "/crm/v3/lists/search").id).toBe("query");
    expect(categoryForOperation("post", "/crm/v3/objects/contacts/batch/read").id).toBe("query");
    expect(categoryForOperation("post", "/oauth/v3/token/introspect").id).toBe("query");
    expect(categoryForOperation("post", "/crm/v3/exports/export/async").id).toBe("query");
  });

  it("flags irreversible operations as destructive", () => {
    expect(categoryForOperation("post", "/crm/v3/objects/contacts/merge").id).toBe("merge");
    expect(categoryForOperation("post", "/crm/v3/objects/contacts/gdpr-delete").id).toBe("purge");
    expect(categoryForOperation("delete", "/files/v3/files/{fileId}/gdpr-delete").id).toBe("purge");
    expect(categoryForOperation("post", "/crm/v3/objects/contacts/batch/archive").id).toBe("bulk_delete");
  });

  it("categorises batch mutations by their real effect", () => {
    expect(categoryForOperation("post", "/crm/v3/objects/contacts/batch/create").id).toBe("create");
    expect(categoryForOperation("post", "/crm/v3/objects/contacts/batch/update").id).toBe("update");
    expect(categoryForOperation("post", "/crm/v3/objects/contacts/batch/upsert").id).toBe("upsert");
  });

  it("treats list memberships as link/unlink, not create/delete", () => {
    expect(categoryForOperation("put", "/crm/v3/lists/{listId}/memberships/add").id).toBe("link");
    expect(categoryForOperation("put", "/crm/v3/lists/{listId}/memberships/add-from/{sourceListId}").id).toBe("link");
    expect(categoryForOperation("put", "/crm/v3/lists/{listId}/memberships/add-and-remove").id).toBe("link");
    expect(categoryForOperation("put", "/crm/v3/lists/{listId}/memberships/remove").id).toBe("unlink");
    expect(categoryForOperation("delete", "/crm/v3/lists/{listId}/memberships").id).toBe("unlink");
  });

  it("treats v4 associations as link/unlink", () => {
    expect(
      categoryForOperation("put", "/crm/v4/objects/{objectType}/{objectId}/associations/{toObjectType}/{toObjectId}").id,
    ).toBe("link");
    expect(
      categoryForOperation("delete", "/crm/v4/objects/{objectType}/{objectId}/associations/{toObjectType}/{toObjectId}").id,
    ).toBe("unlink");
    expect(
      categoryForOperation("post", "/crm/v4/associations/{fromObjectType}/{toObjectType}/batch/create").id,
    ).toBe("link");
    expect(
      categoryForOperation("post", "/crm/v4/associations/{fromObjectType}/{toObjectType}/batch/archive").id,
    ).toBe("unlink");
  });

  it("flags real-world message sends", () => {
    expect(categoryForOperation("post", "/marketing/v3/transactional/single-email/send").id).toBe("send");
    expect(categoryForOperation("post", "/marketing/v4/email/single-send").id).toBe("send");
    expect(categoryForOperation("post", "/automation/v4/sequences/enrollments").id).toBe("send");
    expect(categoryForOperation("post", "/conversations/v3/conversations/threads/{threadId}/messages").id).toBe("send");
  });

  it("flags CRM imports as bulk imports and cancels as updates", () => {
    expect(categoryForOperation("post", "/crm/v3/imports").id).toBe("import");
    expect(categoryForOperation("post", "/crm/v3/imports/{importId}/cancel").id).toBe("update");
  });

  it("treats token revocation as destructive", () => {
    expect(categoryForOperation("post", "/oauth/v3/token/revoke").id).toBe("delete");
    expect(categoryForOperation("delete", "/oauth/v1/refresh-tokens/{token}").id).toBe("delete");
  });

  it("keeps read/write/destructive buckets consistent with annotations", () => {
    for (const meta of Object.values(CATEGORIES)) {
      const bucket = safetyBucket(meta.id);
      if (bucket === "read") expect(meta.annotations.readOnlyHint).toBe(true);
      if (bucket === "destructive") expect(meta.annotations.destructiveHint).toBe(true);
      if (bucket === "write") {
        expect(meta.annotations.readOnlyHint).toBe(false);
        expect(meta.annotations.destructiveHint).toBe(false);
      }
    }
  });

  it("every category has a 🟢/🟡/🔴 banner", () => {
    for (const meta of Object.values(CATEGORIES)) {
      expect(meta.banner).toMatch(/^(🟢|🟡|🔴)/);
    }
  });

  it("every override maps to a real category id", () => {
    for (const id of Object.values(CATEGORY_OVERRIDES)) {
      expect(CATEGORIES[id]).toBeDefined();
    }
  });
});
