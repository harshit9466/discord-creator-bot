const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)(\?|$)/i;

function isImageUrl(url) {
  if (!url) return false; // text-only posts have no media_url at all
  return IMAGE_EXTENSIONS.test(url);
}

module.exports = { isImageUrl };
