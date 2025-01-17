/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */
import { div, input } from "react-dom-factories";
import PropTypes from "prop-types";

export default function ExceptionOption({
  className,
  isChecked = false,
  label,
  onChange,
}) {
  return div(
    {
      className,
      onClick: onChange,
    },
    input({
      type: "checkbox",
      checked: isChecked,
      onChange: e => e.stopPropagation() && onChange(),
    }),
    div(
      {
        className: "breakpoint-exceptions-label",
      },
      label
    )
  );
}

ExceptionOption.propTypes = {
  className: PropTypes.string.isRequired,
  isChecked: PropTypes.bool.isRequired,
  label: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
};
