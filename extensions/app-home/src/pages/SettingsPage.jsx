import {useState, useEffect, useRef} from 'preact/hooks';

// Helper to query Shopify Admin GraphQL API
function gqlFetch(query, variables) {
  return fetch("shopify:admin/api/2026-04/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  }).then((r) => r.json());
}

export default function SettingsPage() {
  const [tags, setTags] = useState('');
  const snapshot = useRef('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const functionIdRef = useRef('');
  const discountNodeIdRef = useRef('');

  // Load configuration on mount
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setError(null);

        // 1. Fetch App Functions to find the 'test' discount function
        const resFunc = await gqlFetch(`#graphql
          query GetAppFunctions {
            shopifyFunctions(first: 20) {
              nodes {
                id
                title
                apiType
              }
            }
          }
        `);

        const functions = resFunc?.data?.shopifyFunctions?.nodes || [];
        const discountFunction = functions.find(
          (f) => f.title === 'test' && f.apiType.toLowerCase() === 'discount'
        );

        if (!discountFunction) {
          setError('Discount function "test" not found. Please deploy the function first.');
          setLoading(false);
          return;
        }

        const fId = discountFunction.id;
        functionIdRef.current = fId;

        // 2. Fetch Automatic Discounts to see if we already have one for this function
        const resDiscounts = await gqlFetch(`#graphql
          query GetAutomaticDiscounts {
            automaticDiscountNodes(first: 50) {
              edges {
                node {
                  id
                  automaticDiscount {
                    ... on DiscountAutomaticApp {
                      id
                      title
                      functionId
                      metafield(namespace: "$app:test", key: "function-config") {
                        id
                        value
                      }
                    }
                  }
                }
              }
            }
          }
        `);

        const discounts = resDiscounts?.data?.automaticDiscountNodes?.edges || [];
        const matchingDiscount = discounts.find(
          (d) => d.node.automaticDiscount?.functionId === fId
        );

        if (matchingDiscount) {
          discountNodeIdRef.current = matchingDiscount.node.automaticDiscount.id;
          const metafieldValue = matchingDiscount.node.automaticDiscount.metafield?.value;
          if (metafieldValue) {
            const parsed = JSON.parse(metafieldValue);
            const tagsList = parsed.tags || [];
            const tagsString = tagsList.join(', ');
            setTags(tagsString);
            snapshot.current = tagsString;
          }
        }
      } catch (err) {
        console.error('Error loading settings:', err);
        setError('Failed to load settings from Shopify.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleReset = () => {
    setTags(snapshot.current);
  };

  const saveSettings = async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);

    const tagsArray = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      if (discountNodeIdRef.current) {
        // Update existing discount node's metafield
        const metafieldInput = {
          ownerId: discountNodeIdRef.current,
          namespace: "$app:test",
          key: "function-config",
          type: "json",
          value: JSON.stringify({ tags: tagsArray }),
        };

        const res = await gqlFetch(`#graphql
          mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields {
                id
              }
              userErrors {
                field
                message
              }
            }
          }
        `, { metafields: [metafieldInput] });

        const errors = res?.data?.metafieldsSet?.userErrors || [];
        if (errors.length > 0) {
          throw new Error(errors[0].message);
        }
      } else {
        // Create new automatic discount node
        const res = await gqlFetch(`#graphql
          mutation CreateAutomaticDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
            discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
              automaticAppDiscount {
                discountId
              }
              userErrors {
                field
                message
              }
            }
          }
        `, {
          automaticAppDiscount: {
            title: "Automatic 10% Customer Tag Discount",
            functionId: functionIdRef.current,
            startsAt: new Date().toISOString(),
            discountClasses: ["ORDER"],
            metafields: [
              {
                namespace: "$app:test",
                key: "function-config",
                type: "json",
                value: JSON.stringify({ tags: tagsArray }),
              },
            ],
          },
        });

        const errors = res?.data?.discountAutomaticAppCreate?.userErrors || [];
        if (errors.length > 0) {
          throw new Error(errors[0].message);
        }

        const newId = res?.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId;
        if (newId) {
          discountNodeIdRef.current = newId;
        } else {
          throw new Error(`Failed to create automatic discount node. API Response: ${JSON.stringify(res || {})}`);
        }
      }

      snapshot.current = tags;
      setSuccess(true);
      if (typeof shopify !== 'undefined' && shopify.toast) {
        shopify.toast.show('Settings saved successfully!');
      }
    } catch (err) {
      console.error('Error saving settings:', err);
      setError(err.message || 'Failed to save settings.');
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const handleSave = (event) => {
    const promise = saveSettings();
    event?.waitUntil?.(promise);
  };

  return (
    <s-page heading="Automatic Discount Settings" inlineSize="small">
      {error && (
        <s-section>
          <s-banner tone="critical">{error}</s-banner>
        </s-section>
      )}

      {success && (
        <s-section>
          <s-banner tone="success">Settings saved successfully!</s-banner>
        </s-section>
      )}

      {loading ? (
        <s-section>
          <s-paragraph>Loading discount configuration...</s-paragraph>
        </s-section>
      ) : (
        <s-section heading="Customer Tag Eligibility">
          <s-form onSubmit={handleSave} onReset={handleReset}>
            <s-grid gap="base">
              <s-paragraph>
                Configure the customer tags that will trigger an automatic 10% discount on the entire order subtotal.
              </s-paragraph>

              <s-text-field
                label="Eligible Customer Tags"
                name="tags"
                placeholder="e.g. VIP, wholesale"
                value={tags}
                onInput={(e) => setTags(e.target.value)}
                details="Enter comma-separated tags. If a logged-in customer has any of these tags, a 10% discount is automatically applied to their entire order."
                disabled={saving}
              />

              <s-button-group>
                <s-button variant="primary" onClick={saveSettings} loading={saving}>
                  Save Settings
                </s-button>
              </s-button-group>
            </s-grid>
          </s-form>
        </s-section>
      )}
    </s-page>
  );
}
