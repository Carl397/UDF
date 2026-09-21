<?php

/**
 * UDF branding for the Roundcube Elastic skin.
 *
 * Two jobs, both upgrade-safe (nothing in the skin or the vendor plugin tree is
 * edited):
 *
 *  1. Adds one stylesheet on every task (including the login screen) so the
 *     party's red / gold / black palette and the UDF flag logo replace the stock
 *     Elastic look.
 *  2. Fills the login page's `loginfooter` template container with the party's
 *     tagline, slogan and manifesto pillars. Roundcube renders that container
 *     through the `template_container` hook (program/include/rcmail_output_html.php),
 *     so the copy becomes real DOM instead of CSS-generated text.
 *
 * The wording is not invented here: the tagline and slogan are the same strings
 * the platform already serves (`PARTY_PROFILE` in
 * backend/src/modules/public/content.ts, published as the `shared.brand` content
 * block), and the seven pillars are the manifesto cards on udf-party.co.za.
 *
 * Installed and refreshed by deploy/scripts/brand-webmail.sh - do not edit it on
 * the server, change the copy in the repo and re-run that script.
 *
 * @license GNU GPLv3+
 */
class udf_branding extends rcube_plugin
{
    public $task = '.*';

    /** One line, joined the same way MoreTab.tsx joins tagline + slogan in the app. */
    const BRAND_LINE = 'One flag · One movement · Service before self';

    /** Short form of the seven manifesto pillars, in manifesto order. */
    private static $pillars = [
        'Housing',
        'Public infrastructure',
        'Crime & safety',
        'Economic empowerment',
        'Accountable councillors',
        'Fair municipal finance',
        'Women & youth',
    ];

    /** @var rcmail */
    private $rcmail;

    function init()
    {
        $this->rcmail = rcmail::get_instance();
        $this->include_stylesheet($this->local_skin_path() . '/udf-branding.css');
        $this->add_hook('template_container', [$this, 'login_branding']);
    }

    /**
     * Inject the brand strip into the login card. Every other container (and
     * every other task) is left exactly as the skin made it.
     *
     * The copy here is all static, but it is still escaped rather than glued in
     * raw so an apostrophe in a pillar title can never break the markup.
     */
    function login_branding($attrib)
    {
        if (($attrib['name'] ?? '') !== 'loginfooter' || $this->rcmail->task !== 'login') {
            return $attrib;
        }

        $pillars = '';
        foreach (self::$pillars as $pillar) {
            $pillars .= '<li>' . htmlspecialchars($pillar, ENT_QUOTES, 'UTF-8') . '</li>';
        }

        $attrib['content'] =
              '<div class="udf-brand-strip">'
            . '<p class="udf-brand-line">' . htmlspecialchars(self::BRAND_LINE, ENT_QUOTES, 'UTF-8') . '</p>'
            . '<ul class="udf-brand-pillars">' . $pillars . '</ul>'
            . '</div>';

        return $attrib;
    }
}
