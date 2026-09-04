# Rail Business Approver

A static GitHub Pages application that signs a user into NCSU ArcGIS Online, verifies membership in an authorized group, previews suggestions where `review = 1`, appends nonduplicate records to the **Rail Businesses** layer, and changes only successfully appended suggestions to `review = 4`.

## Before Deployment

1. Add a text field named `SourceGlobalID` to the target layer. A GUID field is also acceptable if the service accepts source GlobalID values in that field.

2. Ideally, require unique values for `SourceGlobalID` so two simultaneous runs cannot create duplicates.

3. Ensure authorized users can:

   - Query and update the source layer.
   - Add records to the target layer.

4. Register an OAuth application in the NCSU ArcGIS Online organization.

5. Add the final GitHub Pages URL as an allowed redirect URL, including its trailing slash. For example:

   ```text
   https://YOUR_GITHUB_USERNAME.github.io/rail-business-approver/
   ```

6. Edit `dist/config.js` and replace:

   ```text
   REPLACE_WITH_ARCGIS_OAUTH_APP_ID
   REPLACE_WITH_NC_RAIL_BUSINESSES_GROUP_ID
   ```

> **Security warning:** Never add a client secret, password, permanent token, or personal access token to this repository.

## Publish With GitHub Pages

Upload the contents of the `dist` directory to the root of a GitHub repository, or keep the existing project structure and configure GitHub Pages to deploy the `dist` directory using a GitHub Actions Pages workflow.

The simplest manual arrangement is:

1. Place the following files in the repository root:

   - `index.html`
   - `app.js`
   - `config.js`
   - `styles.css`

2. In the GitHub repository, open **Settings → Pages**.

3. Under **Build and deployment**, select **Deploy from a branch**.

4. Select the appropriate branch and the `/ (root)` folder.

5. Save the GitHub Pages settings.

## Test Safely

Before connecting the application to the production layers:

1. Make temporary copies of both layers.

2. Replace the source and target item IDs in `config.js` with the test item IDs.

3. Test each of the following conditions:

   - A successful append
   - An existing duplicate
   - A record with a missing GlobalID
   - A failed source status update

4. Confirm that field types and geometry are transferred correctly.

5. Restore the production item IDs only after testing succeeds.

## Experience Builder

Configure the Experience Builder button to open the GitHub Pages URL in a **new window**.

A top-level browser window is recommended for reliable organizational OAuth redirects.
