const config = window.APP_CONFIG;

const elements = Object.fromEntries(
  [
    "auth-badge", "setup-warning", "error-message", "success-message",
    "signed-out-view", "signed-in-view", "user-name", "unauthorized-view",
    "authorized-view", "approved-count", "duplicate-count", "ready-count",
    "missing-count", "sign-in-button", "sign-out-button", "refresh-button",
    "process-button", "confirm-dialog", "confirm-copy", "confirm-process-button",
    "results-panel", "result-approved", "result-added", "result-updated",
    "result-duplicates", "result-missing", "result-add-failures",
    "result-update-failures", "failure-details", "failure-output"
  ].map((id) => [id, document.getElementById(id)])
);

let identityManager;
let oauthInfo;
let portal;
let sourceLayer;
let targetLayer;
let GraphicClass;
let preview = null;
let busy = false;

function normalizeGlobalId(value) {
  if (value == null) return null;
  return String(value).trim().replace(/^\{|\}$/g, "").toLowerCase() || null;
}

function chunks(values, size) {
  const result = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}

function findField(layer, requestedName) {
  return layer.fields.find(
    (field) => field.name.toLowerCase() === requestedName.toLowerCase()
  );
}

function showMessage(kind, message) {
  for (const key of ["error-message", "success-message"]) elements[key].hidden = true;
  if (!message) return;
  elements[`${kind}-message`].textContent = message;
  elements[`${kind}-message`].hidden = false;
}

function setBusy(value, label = "Working…") {
  busy = value;
  elements["refresh-button"].disabled = value;
  elements["process-button"].disabled = value || !preview || preview.records.length === 0;
  elements["process-button"].textContent = value ? label : "Process approved suggestions";
}

function validateConfiguration() {
  const missing = [];
  if (!config.oauthAppId || config.oauthAppId.startsWith("REPLACE_")) missing.push("oauthAppId");
  if (!config.authorizedGroupId || config.authorizedGroupId.startsWith("REPLACE_")) missing.push("authorizedGroupId");
  if (missing.length) {
    elements["setup-warning"].textContent = `Setup required: replace ${missing.join(" and ")} in config.js.`;
    elements["setup-warning"].hidden = false;
    elements["sign-in-button"].disabled = true;
    return false;
  }
  return true;
}

async function getAllFeaturesByWhere(layer, where, outFields, returnGeometry) {
  const idQuery = layer.createQuery();
  idQuery.where = where;
  const objectIds = await layer.queryObjectIds(idQuery);
  if (!objectIds?.length) return [];

  const features = [];
  for (const objectIdBatch of chunks(objectIds, config.batchSize)) {
    const query = layer.createQuery();
    query.objectIds = objectIdBatch;
    query.outFields = outFields;
    query.returnGeometry = returnGeometry;
    const result = await layer.queryFeatures(query);
    features.push(...result.features);
  }
  return features;
}

async function getMaxRailBusinessId() {
  const idField = findField(
    targetLayer,
    config.railBusinessIdField
  ).name;

  const query = targetLayer.createQuery();

  query.where = `${idField} IS NOT NULL`;
  query.returnGeometry = false;

  query.outStatistics = [
    {
      statisticType: "max",
      onStatisticField: idField,
      outStatisticFieldName: "maxRailBusinessId"
    }
  ];

  const result = await targetLayer.queryFeatures(query);

  const value =
    result.features?.[0]?.attributes?.maxRailBusinessId;

  if (value == null) {
    return 0;
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    throw new Error(
      `Could not determine the maximum ${idField}.`
    );
  }

  return numericValue;
}

async function verifyGroupMembership(username, token) {
  const url =
    `${config.portalUrl}/sharing/rest/community/groups/` +
    `${encodeURIComponent(config.authorizedGroupId)}/users`;

  const body = new URLSearchParams({
    f: "json",
    token
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(
      data.error?.message || "Could not verify group membership."
    );
  }

  const names = [
    data.owner,
    ...(data.admins || []),
    ...(data.users || [])
  ]
    .filter(Boolean)
    .map((name) => String(name).toLowerCase());

  return names.includes(username.toLowerCase());
}

async function initializeLayers(PortalItem, FeatureLayer) {
  sourceLayer = new FeatureLayer({
    portalItem: new PortalItem({ id: config.sourceItemId, portal }),
    layerId: config.sourceLayerIndex
  });
  targetLayer = new FeatureLayer({
    portalItem: new PortalItem({ id: config.targetItemId, portal }),
    layerId: config.targetLayerIndex
  });
  await Promise.all([sourceLayer.load(), targetLayer.load()]);

  if (!findField(sourceLayer, config.reviewField)) {
    throw new Error(`The source does not contain ${config.reviewField}.`);
  }
  if (!findField(sourceLayer, config.suggestionTypeField)) {
    throw new Error(
      `The source does not contain ${config.suggestionTypeField}.`
    );
  }
  if (!sourceLayer.globalIdField) {
    throw new Error("The source layer does not have a GlobalID field.");
  }
  if (!findField(targetLayer, config.targetSourceIdField)) {
    throw new Error(`The target does not contain ${config.targetSourceIdField}. Add it before using this tool.`);
  }
  if (!findField(targetLayer, config.railBusinessIdField)) {
    throw new Error(
      `The target does not contain ${config.railBusinessIdField}. Add it before using this tool.`
    );
  }
  if (!sourceLayer.capabilities?.operations?.supportsEditing) {
    throw new Error("Your account cannot update the source layer.");
  }
  if (!targetLayer.capabilities?.operations?.supportsEditing) {
    throw new Error("Your account cannot add records to the target layer.");
  }
}

async function buildPreview() {
  if (busy) return;

  showMessage(null, null);
  setBusy(true, "Refreshing…");

  try {
    const reviewField =
      findField(sourceLayer, config.reviewField).name;

    const suggestionTypeField =
      findField(sourceLayer, config.suggestionTypeField).name;

    const trackingField =
      findField(targetLayer, config.targetSourceIdField).name;

    const railBusinessIdField =
      findField(targetLayer, config.railBusinessIdField).name;

    const targetOidField = targetLayer.objectIdField;

    const [
      existingTrackingFeatures,
      targetBusinessFeatures,
      approvedFeatures
    ] = await Promise.all([
      getAllFeaturesByWhere(
        targetLayer,
        `${trackingField} IS NOT NULL`,
        [trackingField],
        false
      ),

      getAllFeaturesByWhere(
        targetLayer,
        `${railBusinessIdField} IS NOT NULL`,
        [targetOidField, railBusinessIdField],
        false
      ),

      getAllFeaturesByWhere(
        sourceLayer,
        `${reviewField} = ${Number(config.approvedValue)}`,
        ["*"],
        true
      )
    ]);

    // Used to prevent the same NEW suggestion from being appended twice.
    const existingSourceIds = new Set(
      existingTrackingFeatures
        .map((feature) =>
          normalizeGlobalId(feature.attributes[trackingField])
        )
        .filter(Boolean)
    );

    // RailBusinessID -> target OBJECTID
    const targetByRailBusinessId = new Map();

    for (const feature of targetBusinessFeatures) {
      const id = Number(
        feature.attributes[railBusinessIdField]
      );

      if (Number.isFinite(id)) {
        targetByRailBusinessId.set(
          id,
          feature.attributes[targetOidField]
        );
      }
    }

    const writableTargetFields = new Map();

    for (const field of targetLayer.fields) {
      if (
        ["oid", "global-id"].includes(field.type) ||
        field.editable === false
      ) {
        continue;
      }

      writableTargetFields.set(
        field.name.toLowerCase(),
        field.name
      );
    }

    const records = [];

    let duplicates = 0;
    let missingGlobalId = 0;

    for (const sourceFeature of approvedFeatures) {
      const attributes = sourceFeature.attributes;

      const sourceGlobalId =
        attributes[sourceLayer.globalIdField];

      const normalizedId =
        normalizeGlobalId(sourceGlobalId);

      if (!normalizedId) {
        missingGlobalId += 1;
        continue;
      }

      const suggestionType = String(
        attributes[suggestionTypeField] || "New"
      )
        .trim()
        .toLowerCase();

      const isEdit = suggestionType === "edit";

      // Build attributes shared by New and Edit workflows.
      const destinationAttributes = {};

      for (
        const [sourceName, sourceValue]
        of Object.entries(attributes)
      ) {
        const destinationName =
          writableTargetFields.get(
            sourceName.toLowerCase()
          );

        if (destinationName) {
          destinationAttributes[destinationName] =
            sourceValue;
        }
      }

      if (isEdit) {
        const railBusinessId = Number(
          attributes[config.railBusinessIdField]
        );

        if (!Number.isFinite(railBusinessId)) {
          throw new Error(
            `Approved edit OBJECTID ` +
            `${attributes[sourceLayer.objectIdField]} ` +
            `does not contain a valid RailBusinessID.`
          );
        }

        const targetOid =
          targetByRailBusinessId.get(
            railBusinessId
          );

        if (targetOid == null) {
          throw new Error(
            `Could not find RailBusinessID ` +
            `${railBusinessId} in Rail Businesses.`
          );
        }

        // Required by updateFeatures.
        destinationAttributes[targetOidField] =
          targetOid;

        // Explicitly preserve the same business ID.
        destinationAttributes[railBusinessIdField] =
          railBusinessId;

        records.push({
          mode: "edit",
          sourceOid:
            attributes[sourceLayer.objectIdField],
          sourceGlobalId: normalizedId,
          railBusinessId,
          targetFeature: new GraphicClass({
            geometry: sourceFeature.geometry,
            attributes: destinationAttributes
          })
        });

        continue;
      }

      // NEW suggestion duplicate protection.
      if (existingSourceIds.has(normalizedId)) {
        duplicates += 1;
        continue;
      }

      // Only NEW businesses receive SourceGlobalID.
      destinationAttributes[trackingField] =
        String(sourceGlobalId);

      records.push({
        mode: "new",
        sourceOid:
          attributes[sourceLayer.objectIdField],
        sourceGlobalId: normalizedId,
        targetFeature: new GraphicClass({
          geometry: sourceFeature.geometry,
          attributes: destinationAttributes
        })
      });

      existingSourceIds.add(normalizedId);
    }

    preview = {
      approvedFeatures,
      records,
      duplicates,
      missingGlobalId,
      reviewField
    };

    elements["approved-count"].textContent =
      approvedFeatures.length;

    elements["duplicate-count"].textContent =
      duplicates;

    elements["ready-count"].textContent =
      records.length;

    elements["missing-count"].textContent =
      missingGlobalId;

  } catch (error) {
    preview = null;
    showMessage(
      "error",
      error.message || String(error)
    );

  } finally {
    setBusy(false);
  }
}

function errorSummary(error) {
  if (!error) return "Unknown error";
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    details: error.details
  };
}

async function processApproved() {
  if (busy || !preview?.records.length) return;

  setBusy(true, "Processing…");
  showMessage(null, null);

  const totals = {
    approved: preview.approvedFeatures.length,
    added: 0,
    targetUpdated: 0,
    updated: 0,
    duplicates: preview.duplicates,
    missing: preview.missingGlobalId,
    addFailures: [],
    updateFailures: []
  };

  try {
    const railBusinessIdField =
      findField(
        targetLayer,
        config.railBusinessIdField
      ).name;

    const newRecords =
      preview.records.filter(
        (record) => record.mode === "new"
      );

    const editRecords =
      preview.records.filter(
        (record) => record.mode === "edit"
      );

    // -----------------------------------
    // Assign IDs ONLY to new businesses
    // -----------------------------------

    if (newRecords.length) {
      const maxRailBusinessId =
        await getMaxRailBusinessId();

      let nextRailBusinessId =
        maxRailBusinessId + 1;

      for (const record of newRecords) {
        record.targetFeature.attributes[
          railBusinessIdField
        ] = nextRailBusinessId;

        nextRailBusinessId += 1;
      }
    }

    const successfulRecords = [];

    // -----------------------------------
    // ADD NEW BUSINESSES
    // -----------------------------------

    for (
      const recordBatch
      of chunks(newRecords, config.batchSize)
    ) {
      let addResults;

      try {
        const response =
          await targetLayer.applyEdits(
            {
              addFeatures: recordBatch.map(
                (record) =>
                  record.targetFeature
              )
            },
            {
              rollbackOnFailureEnabled: false
            }
          );

        addResults =
          response.addFeatureResults || [];

      } catch (error) {
        for (const record of recordBatch) {
          totals.addFailures.push({
            sourceOid: record.sourceOid,
            error: errorSummary(error)
          });
        }

        continue;
      }

      recordBatch.forEach(
        (record, index) => {
          const result =
            addResults[index];

          if (result && !result.error) {
            totals.added += 1;
            successfulRecords.push(record);

          } else {
            totals.addFailures.push({
              sourceOid: record.sourceOid,
              error: errorSummary(
                result?.error
              )
            });
          }
        }
      );
    }

    // -----------------------------------
    // UPDATE EXISTING BUSINESSES
    // -----------------------------------

    for (
      const recordBatch
      of chunks(editRecords, config.batchSize)
    ) {
      let editResults;

      try {
        const response =
          await targetLayer.applyEdits(
            {
              updateFeatures:
                recordBatch.map(
                  (record) =>
                    record.targetFeature
                )
            },
            {
              rollbackOnFailureEnabled: false
            }
          );

        editResults =
          response.updateFeatureResults || [];

      } catch (error) {
        for (const record of recordBatch) {
          totals.updateFailures.push({
            sourceOid: record.sourceOid,
            error: errorSummary(error)
          });
        }

        continue;
      }

      recordBatch.forEach(
        (record, index) => {
          const result =
            editResults[index];

          if (result && !result.error) {
            totals.targetUpdated += 1;
            successfulRecords.push(record);

          } else {
            totals.updateFailures.push({
              sourceOid: record.sourceOid,
              error: errorSummary(
                result?.error
              )
            });
          }
        }
      );
    }

    // -----------------------------------
    // MARK SUCCESSFUL SUGGESTIONS
    // AS PROCESSED
    // -----------------------------------

    if (successfulRecords.length) {
      const sourceUpdates =
        successfulRecords.map(
          (record) =>
            new GraphicClass({
              attributes: {
                [sourceLayer.objectIdField]:
                  record.sourceOid,

                [preview.reviewField]:
                  config.processedValue
              }
            })
        );

      try {
        const response =
          await sourceLayer.applyEdits(
            {
              updateFeatures:
                sourceUpdates
            },
            {
              rollbackOnFailureEnabled: false
            }
          );

        const results =
          response.updateFeatureResults || [];

        successfulRecords.forEach(
          (record, index) => {
            const result = results[index];

            if (result && !result.error) {
              totals.updated += 1;

            } else {
              totals.updateFailures.push({
                sourceOid:
                  record.sourceOid,
                error:
                  errorSummary(
                    result?.error
                  )
              });
            }
          }
        );

      } catch (error) {
        for (
          const record
          of successfulRecords
        ) {
          totals.updateFailures.push({
            sourceOid: record.sourceOid,
            error: errorSummary(error)
          });
        }
      }
    }

    renderResults(totals);

    showMessage(
      "success",
      `Completed: ` +
      `${totals.added} new business` +
      `${totals.added === 1 ? "" : "es"} added, ` +
      `${totals.targetUpdated} existing business` +
      `${totals.targetUpdated === 1 ? "" : "es"} updated, ` +
      `and ${totals.updated} suggestion` +
      `${totals.updated === 1 ? "" : "s"} marked processed.`
    );

    await buildPreview();

  } finally {
    setBusy(false);
  }
}

function renderResults(totals) {
  const values = {
    "result-approved": totals.approved,
    "result-added": totals.added,
    "result-updated": totals.updated,
    "result-duplicates": totals.duplicates,
    "result-missing": totals.missing,
    "result-add-failures": totals.addFailures.length,
    "result-update-failures": totals.updateFailures.length
  };
  for (const [id, value] of Object.entries(values)) elements[id].textContent = value;
  const failures = { appendFailures: totals.addFailures, statusUpdateFailures: totals.updateFailures };
  const hasFailures = totals.addFailures.length || totals.updateFailures.length;
  elements["failure-details"].hidden = !hasFailures;
  elements["failure-output"].textContent = hasFailures ? JSON.stringify(failures, null, 2) : "";
  elements["results-panel"].hidden = false;
}

async function start() {
  if (!validateConfiguration()) return;

  const [OAuthInfo, IdentityManager, Portal, PortalItem, FeatureLayer, Graphic] = await $arcgis.import([
    "@arcgis/core/identity/OAuthInfo.js",
    "@arcgis/core/identity/IdentityManager.js",
    "@arcgis/core/portal/Portal.js",
    "@arcgis/core/portal/PortalItem.js",
    "@arcgis/core/layers/FeatureLayer.js",
    "@arcgis/core/Graphic.js"
  ]);
  GraphicClass = Graphic;
  identityManager = IdentityManager;
  oauthInfo = new OAuthInfo({ appId: config.oauthAppId, portalUrl: config.portalUrl, popup: false });
  identityManager.registerOAuthInfos([oauthInfo]);

  elements["sign-in-button"].addEventListener("click", async () => {
    await identityManager.getCredential(`${config.portalUrl}/sharing`);
    window.location.reload();
  });
  elements["sign-out-button"].addEventListener("click", () => {
    identityManager.destroyCredentials();
    window.location.reload();
  });
  elements["refresh-button"].addEventListener("click", buildPreview);
  elements["process-button"].addEventListener("click", () => {
    elements["confirm-copy"].textContent = `${preview.records.length} approved suggestion` + `${preview.records.length === 1 ? "" : "s"} will be processed. ` + `New businesses will be added and approved edits will update existing businesses. ` + `This action changes production data.`;
    elements["confirm-dialog"].showModal();
  });
  elements["confirm-dialog"].addEventListener("close", () => {
    if (elements["confirm-dialog"].returnValue === "confirm") processApproved();
  });

  try {
    await identityManager.checkSignInStatus(`${config.portalUrl}/sharing`);
  } catch {
    return;
  }

  try {
    const credential = await identityManager.getCredential(`${config.portalUrl}/sharing`);
    portal = new Portal({ url: config.portalUrl, authMode: "immediate" });
    await portal.load();

    elements["signed-out-view"].hidden = true;
    elements["signed-in-view"].hidden = false;
    elements["user-name"].textContent = `${portal.user.fullName} (${portal.user.username})`;
    elements["auth-badge"].textContent = "Signed in";
    elements["auth-badge"].className = "badge good";

    const authorized = await verifyGroupMembership(portal.user.username, credential.token);
    elements["unauthorized-view"].hidden = authorized;
    elements["authorized-view"].hidden = !authorized;
    if (!authorized) return;

    await initializeLayers(PortalItem, FeatureLayer);
    await buildPreview();
  } catch (error) {
    showMessage("error", error.message || String(error));
  }
}

start();
