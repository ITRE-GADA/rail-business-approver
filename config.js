// Public browser configuration. Do not put passwords or client secrets here.
window.APP_CONFIG = Object.freeze({
  portalUrl: "https://ncsu.maps.arcgis.com",
  oauthAppId: "REPLACE_WITH_ARCGIS_OAUTH_APP_ID",
  authorizedGroupId: "REPLACE_WITH_NC_RAIL_BUSINESSES_GROUP_ID",

  sourceItemId: "186e115c218e4a41a1851b5fc119ba45",
  sourceLayerIndex: 0,
  targetItemId: "cdbc92831afe40e3bcc1cbba74c1a754",
  targetLayerIndex: 0,

  reviewField: "review",
  approvedValue: 1,
  processedValue: 4,
  targetSourceIdField: "SourceGlobalID",
  batchSize: 200
});
