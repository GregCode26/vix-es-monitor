"use client";

import React from "react";
import styles from "./EmptyPanel.module.css";

interface EmptyPanelProps {
  title?: string;
}

export const EmptyPanel: React.FC<EmptyPanelProps> = ({ title = "Sub Panel" }) => {
  return (
    <div className={styles.emptyPanel}>
      <div className={styles.placeholder}>
        <div className={styles.title}>{title}</div>
        <div className={styles.text}>Empty</div>
      </div>
    </div>
  );
};
